import { Router, Response } from "express";
import { Pool } from "pg";
import { authMiddleware } from "../middleware/auth";

export const createChatRoutes = (pool: Pool): Router => {
  const router = Router();

  router.use(authMiddleware);

  router.post("/", async (req: any, res: Response) => {
    const creatorId = req.user.userId;
    const { name, type } = req.body;

    if (!name) {
      return res.status(400).json({
        message: "Название чата обязательно",
      });
    }

    const chatType = type || "private";
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const chatResult = await client.query(
        "INSERT INTO chats (name, type, created_by) VALUES ($1, $2, $3) RETURNING *",
        [name, chatType, creatorId],
      );

      const newChat = chatResult.rows[0];

      await client.query(
        "INSERT INTO chat_participants (chat_id, user_id) VALUES ($1, $2)",
        [newChat.id, creatorId],
      );

      await client.query("COMMIT");

      return res.status(200).json({
        message: "Чат создан",
        chat: newChat,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Ошибка создания чата:", error);
      return res.status(500).json({
        message: "Ошибка при создании чата",
      });
    } finally {
      client.release();
    }
  });

  router.get("/", async (req: any, res: Response) => {
    const userId = req.user.userId;

    try {
      const result = await pool.query(
        `SELECT c.id, c.name, c.type, c.video_url, c.created_at
         FROM chats c
         INNER JOIN chat_participants cp ON c.id = cp.chat_id
         WHERE cp.user_id = $1
         ORDER BY c.created_at DESC`,
        [userId],
      );

      return res.status(200).json({ chats: result.rows });
    } catch (error) {
      console.error("Ошибка получения чатов", error);
      res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.get("/:id", async (req: any, res: Response) => {
    const userId = req.user.userId;
    const chatId = req.params.id;

    try {
      const accessCheck = await pool.query(
        "SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2",
        [chatId, userId],
      );

      if (accessCheck.rows.length === 0) {
        return res
          .status(403)
          .json({ message: "У вас нет доступа к этому чату" });
      }

      const chatResult = await pool.query("SELECT * FROM chats WHERE id = $1", [
        chatId,
      ]);

      return res.status(200).json({ chat: chatResult.rows[0] });
    } catch (error) {
      console.error("Ошибка получения чата:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.get("/:id/messages", async (req: any, res: Response) => {
    const userId = req.user.userId;
    const chatId = req.params.id;

    try {
      const accessCheck = await pool.query(
        "SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2",
        [chatId, userId],
      );

      if (accessCheck.rows.length === 0) {
        return res.status(403).json({
          message: "Нет доступа к сообщениям",
        });
      }

      const result = await pool.query(
        `SELECT m.id, m.user_id, m.content, m.created_at, m.type, u.username
         FROM messages m
         JOIN users u ON m.user_id = u.id
         WHERE m.chat_id = $1
         ORDER BY m.created_at ASC
         LIMIT 50`,
        [chatId],
      );

      return res.status(200).json({
        messages: result.rows,
      });
    } catch (error) {
      console.error("Ошибка получения сообщений:", error);
      return res.status(500).json({
        message: "Ошибка сервера",
      });
    }
  });

  router.post("/:id/participants", async (req: any, res: Response) => {
    const chatId = req.params.id;
    const requesterId = req.user.userId;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ message: "Укажите ID пользователя" });
    }

    try {
      const accessCheck = await pool.query(
        "SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2",
        [chatId, requesterId],
      );
      if (accessCheck.rows.length === 0) {
        return res
          .status(403)
          .json({ message: "Вы не можете добавлять людей в этот чат" });
      }

      const existingParticipant = await pool.query(
        "SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2",
        [chatId, userId],
      );
      if (existingParticipant.rows.length > 0) {
        return res
          .status(409)
          .json({ message: "Пользователь уже в этом чате" });
      }

      await pool.query(
        "INSERT INTO chat_participants (chat_id, user_id) VALUES ($1, $2)",
        [chatId, userId],
      );

      return res.status(201).json({ message: "Участник успешно добавлен" });
    } catch (error) {
      console.error("Ошибка добавления в чат:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.get("/:id/participants", async (req: any, res: Response) => {
    const chatId = req.params.id;
    const myId = req.user.userId;

    try {
      const accessCheck = await pool.query(
        "SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2",
        [chatId, myId],
      );
      if (accessCheck.rows.length === 0) {
        return res.status(403).json({ message: "Нет доступа к чату" });
      }

      const result = await pool.query(
        `SELECT u.id, u.username, u.avatar_url
         FROM users u
         JOIN chat_participants cp ON u.id = cp.user_id
         WHERE cp.chat_id = $1`,
        [chatId],
      );

      return res.status(200).json({ participants: result.rows });
    } catch (error) {
      console.error("Ошибка получения участников:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  return router;
};
