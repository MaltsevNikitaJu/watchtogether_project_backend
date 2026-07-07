import { Router, Response, Request } from "express";
import { Pool } from "pg";
import { authMiddleware } from "../middleware/auth";
import multer from "multer";
import path from "path";
import fs from "fs";

interface AuthRequest extends Request {
  user?: {
    userId: number;
    role: string;
  };
}

const uploadDir = path.join(process.cwd(), 'uploads', 'avatars');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `avatar-${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      cb(null, true);
    } else {
      cb(new Error('Только изображения (jpeg, jpg, png, gif, webp) разрешены'));
    }
  },
});

export const createUserRoutes = (pool: Pool): Router => {
  const router = Router();

  router.use(authMiddleware);

  router.get("/search", async (req: AuthRequest, res: Response) => {
    const myId = req.user?.userId;
    if (!myId) return res.status(401).json({ message: "Не авторизован" });
    const query = req.query.query as string;

    if (!query || query.length < 2) {
      return res
        .status(400)
        .json({ message: "Запрос должен быть не менее 2 символов" });
    }

    if (query.length > 50) {
      return res
        .status(400)
        .json({ message: "Запрос не может превышать 50 символов" });
    }

    try {
      const result = await pool.query(
        `SELECT id, username, avatar_url
         FROM users
         WHERE (username ILIKE $1 OR email ILIKE $1)
         AND id != $2
         LIMIT 20`,
        [`%${query}%`, myId],
      );

      return res.status(200).json({ users: result.rows });
    } catch (error) {
      console.error("Ошибка поиска пользователей:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.post("/friend-request", async (req: AuthRequest, res: Response) => {
    const requesterId = req.user?.userId;
    if (!requesterId) return res.status(401).json({ message: "Не авторизован" });

    const { addresseeId } = req.body;

    if (!addresseeId) {
      return res.status(400).json({ message: "Укажите ID пользователя" });
    }

    try {
      const existingRequest = await pool.query(
        `SELECT id, status, requester_id FROM friendships
         WHERE (requester_id = $1 AND addressee_id = $2)
            OR (requester_id = $2 AND addressee_id = $1)`,
        [requesterId, addresseeId],
      );

      if (existingRequest.rows.length > 0) {
        const relation = existingRequest.rows[0];

        if (relation.status === "pending") {
          return res
            .status(409)
            .json({
              message: "Заявка уже отправлена или ожидает вашего ответа",
            });
        }
        if (relation.status === "accepted") {
          return res.status(409).json({ message: "Вы уже друзья" });
        }
        if (relation.status === "rejected") {
          return res
            .status(409)
            .json({ message: "Заявка была отклонена ранее" });
        }
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const doubleCheck = await client.query(
          `SELECT id, status FROM friendships
           WHERE (requester_id = $1 AND addressee_id = $2)
              OR (requester_id = $2 AND addressee_id = $1)
           FOR UPDATE`,
          [requesterId, addresseeId],
        );

        if (doubleCheck.rows.length > 0) {
          await client.query("ROLLBACK");
          const relation = doubleCheck.rows[0];
          if (relation.status === "pending") {
            return res.status(409).json({ message: "Заявка уже отправлена или ожидает вашего ответа" });
          }
          if (relation.status === "accepted") {
            return res.status(409).json({ message: "Вы уже друзья" });
          }
          return res.status(409).json({ message: "Заявка была отклонена ранее" });
        }

        await client.query(
          "INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, $3)",
          [requesterId, addresseeId, "pending"],
        );
        await client.query("COMMIT");

        return res.status(201).json({ message: "Заявка в друзья отправлена" });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Ошибка отправки заявки:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.patch(
    "/friend-request/:requestId",
    async (req: AuthRequest, res: Response) => {
      const myId = req.user?.userId;
      if (!myId) return res.status(401).json({ message: "Не авторизован" });
      const requestId = req.params.requestId;
      const { action } = req.body;

      if (!action || !["accept", "reject"].includes(action)) {
        return res
          .status(400)
          .json({ message: "Укажите корректное действие: accept или reject" });
      }

      try {
        const result = await pool.query(
          "SELECT * FROM friendships WHERE id = $1",
          [requestId],
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ message: "Заявка не найдена" });
        }

        const request = result.rows[0];

        if (request.addressee_id !== myId) {
          return res
            .status(403)
            .json({ message: "Вы не можете ответить на эту заявку" });
        }

        if (request.status !== "pending") {
          return res.status(400).json({ message: "Заявка уже обработана" });
        }

        const newStatus = action === "accept" ? "accepted" : "rejected";
        await pool.query("UPDATE friendships SET status = $1 WHERE id = $2", [
          newStatus,
          requestId,
        ]);

        const message =
          action === "accept"
            ? "Заявка принята. Вы теперь друзья!"
            : "Заявка отклонена";
        return res.status(200).json({ message });
      } catch (error) {
        console.error("Ошибка обработки заявки:", error);
        return res.status(500).json({ message: "Ошибка сервера" });
      }
    },
  );

  router.get("/friend-requests", async (req: AuthRequest, res: Response) => {
    const myId = req.user?.userId;
    if (!myId) return res.status(401).json({ message: "Не авторизован" });

    try {
      const result = await pool.query(
        `SELECT f.id, f.requester_id, f.created_at,
         u.id as user_id, u.username, u.avatar_url
         FROM friendships f
         JOIN users u ON f.requester_id = u.id
         WHERE f.addressee_id = $1 AND f.status = 'pending'
         ORDER BY f.created_at DESC`,
        [myId],
      );

      const requests = result.rows.map(row => ({
        id: row.id,
        requester: {
          id: row.user_id,
          username: row.username,
          avatar_url: row.avatar_url,
        },
        created_at: row.created_at,
      }));

      return res.status(200).json({ requests });
    } catch (error) {
      console.error("Ошибка получения заявок в друзья:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.get("/friends", async (req: AuthRequest, res: Response) => {
    const myId = req.user?.userId;
    if (!myId) return res.status(401).json({ message: "Не авторизован" });

    try {
      const result = await pool.query(
        `SELECT u.id, u.username, u.avatar_url
         FROM users u
         JOIN friendships f ON (
           (f.requester_id = $1 AND f.addressee_id = u.id) OR
           (f.addressee_id = $1 AND f.requester_id = u.id)
         )
         WHERE f.status = 'accepted'`,
        [myId],
      );

      return res.status(200).json({ friends: result.rows });
    } catch (error) {
      console.error("Ошибка получения друзей:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.get("/me", async (req: AuthRequest, res: Response) => {
    const myId = req.user?.userId;
    if (!myId) return res.status(401).json({ message: "Не авторизован" });

    try {
      const result = await pool.query(
        "SELECT id, username, email, avatar_url, created_at FROM users WHERE id = $1",
        [myId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ message: "Пользователь не найден" });
      }

      return res.status(200).json({ user: result.rows[0] });
    } catch (error) {
      console.error("Ошибка получения профиля:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.patch("/me", async (req: AuthRequest, res: Response) => {
    const myId = req.user?.userId;
    if (!myId) return res.status(401).json({ message: "Не авторизован" });

    const { username, avatar_url } = req.body;

    try {
      if (username) {
        const existingUser = await pool.query(
          "SELECT id FROM users WHERE username = $1 AND id != $2",
          [username, myId],
        );

        if (existingUser.rows.length > 0) {
          return res.status(400).json({ message: "Это имя уже занято" });
        }
      }

      const updates: string[] = [];
      const values: (string | number)[] = [];
      let paramIndex = 1;

      if (username) {
        updates.push(`username = $${paramIndex}`);
        values.push(username);
        paramIndex++;
      }

      if (avatar_url !== undefined) {
        updates.push(`avatar_url = $${paramIndex}`);
        values.push(avatar_url);
        paramIndex++;
      }

      if (updates.length === 0) {
        return res.status(400).json({ message: "Нет данных для обновления" });
      }

      values.push(myId);

      const result = await pool.query(
        `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING id, username, email, avatar_url`,
        values,
      );

      return res.status(200).json({
        message: "Профиль обновлен",
        user: result.rows[0],
      });
    } catch (error) {
      console.error("Ошибка обновления профиля:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.get("/history", async (req: AuthRequest, res: Response) => {
    const myId = req.user?.userId;
    if (!myId) return res.status(401).json({ message: "Не авторизован" });

    try {
      const result = await pool.query(
        `SELECT DISTINCT
           c.id as chat_id,
           c.name as chat_name,
           MAX(m.created_at) as last_watched
         FROM chat_participants cp
         JOIN chats c ON cp.chat_id = c.id
         JOIN messages m ON m.chat_id = c.id
         WHERE cp.user_id = $1
         GROUP BY c.id, c.name
         ORDER BY last_watched DESC
         LIMIT 20`,
        [myId],
      );

      return res.status(200).json({ history: result.rows });
    } catch (error) {
      console.error("Ошибка получения истории:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.post("/avatar", upload.single('avatar'), async (req: AuthRequest, res: Response) => {
    const myId = req.user?.userId;
    if (!myId) return res.status(401).json({ message: "Не авторизован" });

    if (!req.file) {
      return res.status(400).json({ message: "Файл не загружен" });
    }

    try {
      const avatarUrl = `/uploads/avatars/${req.file.filename}`;

      await pool.query(
        "UPDATE users SET avatar_url = $1 WHERE id = $2",
        [avatarUrl, myId],
      );

      return res.status(200).json({
        message: "Аватар обновлен",
        avatarUrl,
      });
    } catch (error) {
      console.error("Ошибка обновления аватара:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  return router;
};
