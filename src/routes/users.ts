import { Router, Response } from "express";
import { Pool } from "pg";
import { authMiddleware } from "../middleware/auth";

export const createUserRoutes = (pool: Pool): Router => {
  const router = Router();

  router.use(authMiddleware);

  router.get("/search", async (req: any, res: Response) => {
    const myId = req.user.userId;
    const query = req.query.query as string;

    if (!query || query.length < 2) {
      return res
        .status(400)
        .json({ message: "Запрос должен быть не менее 2 символов" });
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

  router.post("/friend-request", async (req: any, res: Response) => {
    const requesterId = req.user.userId;
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

      await pool.query(
        "INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, $3)",
        [requesterId, addresseeId, "pending"],
      );

      return res.status(201).json({ message: "Заявка в друзья отправлена" });
    } catch (error) {
      console.error("Ошибка отправки заявки:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.patch(
    "/friend-request/:requestId",
    async (req: any, res: Response) => {
      const myId = req.user.userId;
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

  router.get("/friends", async (req: any, res: Response) => {
    const myId = req.user.userId;

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

  return router;
};
