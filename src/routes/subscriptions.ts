import { Router, Response, Request } from "express";
import { Pool } from "pg";
import crypto from "crypto";
import { authMiddleware } from "../middleware/auth";
import { expireIfNeeded } from "../middleware/premium";

interface AuthRequest extends Request {
  user?: {
    userId: number;
    role: string;
  };
}

const PLAN_PRICES: Record<string, string> = {
  premium: "299.00",
  premium_plus: "2499.00",
};

const PLAN_LABELS: Record<string, string> = {
  premium: "Premium",
  premium_plus: "Premium+",
};

const applySubscriptionUpgrade = async (pool: Pool, userId: number, plan: string) => {
  const now = new Date();
  const startDate = now;
  let endDate: Date | null = null;
  if (plan === "premium") {
    const end = new Date(now);
    end.setMonth(end.getMonth() + 1);
    endDate = end;
  } else if (plan === "premium_plus") {
    const end = new Date(now);
    end.setFullYear(end.getFullYear() + 1);
    endDate = end;
  }

  const currentResult = await pool.query(
    "SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
    [userId],
  );

  let subscription;
  if (currentResult.rows.length === 0) {
    const result = await pool.query(
      `INSERT INTO subscriptions (user_id, plan, status, start_date, end_date, auto_renew)
       VALUES ($1, $2, 'active', $3, $4, true)
       RETURNING *`,
      [userId, plan, startDate, endDate],
    );
    subscription = result.rows[0];
  } else {
    const result = await pool.query(
      `UPDATE subscriptions
       SET plan = $1, status = 'active', start_date = $2, end_date = $3, auto_renew = true
       WHERE id = $4
       RETURNING *`,
      [plan, startDate, endDate, currentResult.rows[0].id],
    );
    subscription = result.rows[0];
  }

  await pool.query("UPDATE users SET role = $1 WHERE id = $2", [plan, userId]);
  return subscription;
};

const yookassaAuthHeader = (): string | null => {
  const shopId = process.env.YOOKASSA_SHOP_ID;
  const secretKey = process.env.YOOKASSA_SECRET_KEY;
  if (!shopId || !secretKey) return null;
  return "Basic " + Buffer.from(`${shopId}:${secretKey}`).toString("base64");
};

export const createSubscriptionRoutes = (pool: Pool): Router => {
  const router = Router();

  router.use(authMiddleware);
  router.get("/my", async (req: AuthRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Не авторизован" });

    try {
      await expireIfNeeded(pool, userId);
      const result = await pool.query(
        `SELECT s.*,
          CASE
            WHEN s.end_date IS NULL THEN true
            WHEN s.end_date > CURRENT_TIMESTAMP THEN true
            ELSE false
          END as is_active
         FROM subscriptions s
         WHERE s.user_id = $1
         ORDER BY s.created_at DESC
         LIMIT 1`,
        [userId]
      );

      if (result.rows.length === 0) {
        const newSubscription = await pool.query(
          "INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, 'free', 'active') RETURNING *",
          [userId]
        );

        const subscription = newSubscription.rows[0];
        subscription.is_active = true;

        return res.status(200).json({ subscription });
      }

      const subscription = result.rows[0];
      return res.status(200).json({ subscription });
    } catch (error) {
      console.error("Ошибка получения подписки:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.post("/upgrade", async (req: AuthRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Не авторизован" });

    const { plan } = req.body;
    if (!plan || !PLAN_PRICES[plan]) {
      return res.status(400).json({ message: "Некорректный план подписки" });
    }

    try {
      const subscription = await applySubscriptionUpgrade(pool, userId, plan);
      return res.status(200).json({
        message: "Подписка успешно оформлена!",
        subscription: { ...subscription, is_active: true },
      });
    } catch (error) {
      console.error("Ошибка оформления подписки:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.post("/create-payment", async (req: AuthRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Не авторизован" });

    const { plan } = req.body;
    if (!plan || !PLAN_PRICES[plan]) {
      return res.status(400).json({ message: "Некорректный план подписки" });
    }

    const auth = yookassaAuthHeader();
    if (!auth) {
      return res.status(500).json({ message: "Платежи не настроены на сервере (YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY)" });
    }

    const returnUrl =
      process.env.YOOKASSA_RETURN_URL ||
      `${process.env.FRONTEND_URL || "http://localhost:5173"}/subscription?payment=return`;

    try {
      const idempotenceKey = crypto.randomUUID();
      const ykRes = await fetch("https://api.yookassa.ru/v3/payments", {
        method: "POST",
        headers: {
          Authorization: auth,
          "Idempotence-Key": idempotenceKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: { value: PLAN_PRICES[plan], currency: "RUB" },
          capture: true,
          confirmation: { type: "redirect", return_url: returnUrl },
          description: `Подписка ${PLAN_LABELS[plan]} — WatchTogether`,
          metadata: { user_id: String(userId), plan },
        }),
      });

      if (!ykRes.ok) {
        const errText = await ykRes.text();
        console.error("YooKassa create-payment error:", ykRes.status, errText);
        return res.status(502).json({ message: "Не удалось создать платёж в ЮKassa" });
      }

      const payment = (await ykRes.json()) as {
        id: string;
        status: string;
        confirmation?: { confirmation_url?: string };
      };
      const confirmationUrl = payment.confirmation?.confirmation_url;

      await pool.query(
        "INSERT INTO payments (yookassa_payment_id, user_id, plan, amount, status) VALUES ($1, $2, $3, $4, 'pending')",
        [payment.id, userId, plan, PLAN_PRICES[plan]],
      );

      if (!confirmationUrl) {
        return res.status(502).json({ message: "ЮKassa не вернула URL для оплаты" });
      }

      return res.status(200).json({ confirmation_url: confirmationUrl, payment_id: payment.id });
    } catch (error) {
      console.error("Ошибка создания платежа:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.get("/payment-status", async (req: AuthRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Не авторизован" });

    const auth = yookassaAuthHeader();
    if (!auth) return res.status(200).json({ status: "none" });

    try {
      const pending = await pool.query(
        "SELECT yookassa_payment_id, plan FROM payments WHERE user_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
        [userId],
      );
      if (pending.rows.length === 0) {
        return res.status(200).json({ status: "none" });
      }

      const { yookassa_payment_id, plan } = pending.rows[0];

      const ykRes = await fetch(`https://api.yookassa.ru/v3/payments/${yookassa_payment_id}`, {
        headers: { Authorization: auth },
      });
      if (!ykRes.ok) {
        return res.status(200).json({ status: "pending" });
      }
      const payment = (await ykRes.json()) as { status: string };

      if (payment.status === "succeeded") {
        const updated = await pool.query(
          "UPDATE payments SET status = 'succeeded' WHERE yookassa_payment_id = $1 AND status = 'pending' RETURNING id",
          [yookassa_payment_id],
        );
        if (updated.rows.length > 0) {
          await applySubscriptionUpgrade(pool, userId, plan);
        }
        return res.status(200).json({ status: "succeeded", plan });
      }

      if (payment.status === "canceled") {
        await pool.query(
          "UPDATE payments SET status = 'canceled' WHERE yookassa_payment_id = $1 AND status = 'pending'",
          [yookassa_payment_id],
        );
        return res.status(200).json({ status: "canceled" });
      }

      return res.status(200).json({ status: "pending" });
    } catch (error) {
      console.error("Ошибка проверки статуса платежа:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.post("/cancel", async (req: AuthRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Не авторизован" });

    try {
      const result = await pool.query(
        `UPDATE subscriptions
         SET status = 'cancelled', auto_renew = false
         WHERE user_id = $1 AND plan IN ('premium', 'premium_plus') AND status = 'active'
         RETURNING *`,
        [userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ message: "Активная подписка не найдена" });
      }

      return res.status(200).json({
        message: "Подписка отменена. Доступ сохранится до конца оплаченного периода.",
        subscription: result.rows[0]
      });
    } catch (error) {
      console.error("Ошибка отмены подписки:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  return router;
};