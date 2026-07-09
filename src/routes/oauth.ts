import { Router, Request, Response } from "express";
import { Pool } from "pg";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import fs from "fs";
import path from "path";

interface YandexUserInfo {
  id: string;
  login?: string;
  default_email?: string;
  emails?: string[];
  display_name?: string;
  first_name?: string;
  last_name?: string;
  default_avatar_id?: string;
  is_avatar_empty?: boolean;
}

const getCookie = (req: Request, name: string): string | undefined => {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const match = header.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
};

const downloadYandexAvatar = async (info: YandexUserInfo): Promise<string | null> => {
  if (info.is_avatar_empty || !info.default_avatar_id) return null;
  try {
    const url = `https://avatars.yandex.net/get-yapic/${info.default_avatar_id}/islands-200`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const dir = path.join(process.cwd(), "uploads", "avatars");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const safeId = info.default_avatar_id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
    const filename = `yandex_${safeId}.jpg`;
    fs.writeFileSync(path.join(dir, filename), buf);
    return `/uploads/avatars/${filename}`;
  } catch {
    return null;
  }
};

export const createYandexAuthRouter = (pool: Pool): Router => {
  const router = Router();

  const clientId = process.env.YANDEX_CLIENT_ID;
  const clientSecret = process.env.YANDEX_CLIENT_SECRET;
  const redirectUri =
    process.env.YANDEX_REDIRECT_URI || "http://localhost:3001/api/auth/yandex/callback";
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  const jwtSecret = process.env.JWT_SECRET;

  const failRedirect = (reason: string) => `${frontendUrl}/oauth/success?error=${reason}`;

  router.get("/yandex", (req: Request, res: Response) => {
    if (!clientId || !clientSecret || !jwtSecret) {
      return res.redirect(failRedirect("config"));
    }
    const state = crypto.randomUUID();
    res.cookie("oauth_state", state, {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 10 * 60 * 1000,
    });
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
    });
    res.redirect(`https://oauth.yandex.ru/authorize?${params.toString()}`);
  });

  router.get("/yandex/callback", async (req: Request, res: Response) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const cookieState = getCookie(req, "oauth_state");

    if (!state || !cookieState || state !== cookieState) {
      return res.redirect(failRedirect("state"));
    }
    res.clearCookie("oauth_state");
    if (!code) return res.redirect(failRedirect("no_code"));

    if (!clientId || !clientSecret || !jwtSecret) {
      return res.redirect(failRedirect("config"));
    }

    try {
      const tokenRes = await fetch("https://oauth.yandex.ru/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenRes.ok) return res.redirect(failRedirect("token"));
      const tokenJson = (await tokenRes.json()) as { access_token?: string };
      if (!tokenJson.access_token) return res.redirect(failRedirect("token"));

      const infoRes = await fetch("https://login.yandex.ru/info", {
        headers: { Authorization: `OAuth ${tokenJson.access_token}` },
      });
      if (!infoRes.ok) return res.redirect(failRedirect("userinfo"));
      const info = (await infoRes.json()) as YandexUserInfo;

      const yandexId = String(info.id);
      const email = info.default_email || info.emails?.[0] || null;
      const baseUsername = (info.login || `yandex_${yandexId}`).slice(0, 30);

      let userResult = await pool.query("SELECT * FROM users WHERE yandex_id = $1", [yandexId]);
      let user = userResult.rows[0];

      if (!user && email) {
        const byEmail = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
        user = byEmail.rows[0];
        if (user) {
          await pool.query("UPDATE users SET yandex_id = $1 WHERE id = $2", [yandexId, user.id]);
        }
      }

      if (!user) {
        let username = baseUsername;
        let n = 1;
        while (true) {
          const taken = await pool.query("SELECT 1 FROM users WHERE username = $1", [username]);
          if (taken.rows.length === 0) break;
          const suffix = `_${n++}`;
          username = `${baseUsername.slice(0, 30 - suffix.length)}${suffix}`;
        }

        const avatarUrl = await downloadYandexAvatar(info);
        const insertRes = await pool.query(
          `INSERT INTO users (username, email, password_hash, yandex_id, avatar_url, role)
           VALUES ($1, $2, NULL, $3, $4, 'user') RETURNING *`,
          [username, email, yandexId, avatarUrl],
        );
        user = insertRes.rows[0];

        await pool.query(
          "INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, 'free', 'active')",
          [user.id],
        );
      } else if (!user.avatar_url) {
        const avatarUrl = await downloadYandexAvatar(info);
        if (avatarUrl) {
          await pool.query("UPDATE users SET avatar_url = $1 WHERE id = $2", [avatarUrl, user.id]);
        }
      }

      const token = jwt.sign({ userId: user.id, role: user.role }, jwtSecret, {
        expiresIn: "24h",
      });
      return res.redirect(`${frontendUrl}/oauth/success?token=${token}`);
    } catch (e) {
      console.error("Yandex OAuth error:", e);
      return res.redirect(failRedirect("server"));
    }
  });

  return router;
};
