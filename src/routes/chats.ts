import { Router, Response, Request } from "express";
import { Pool } from "pg";
import { authMiddleware } from "../middleware/auth";

interface AuthRequest extends Request {
  user?: {
    userId: number;
    role: string;
  };
}

export const createChatRoutes = (pool: Pool): Router => {
  const router = Router();

  router.use(authMiddleware);

  router.post("/", async (req: AuthRequest, res: Response) => {
    const creatorId = req.user!.userId;
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

  router.get("/", async (req: AuthRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Не авторизован" });

    try {
      const result = await pool.query(
        `SELECT c.id, c.name, c.type, c.video_url, c.created_at, c.created_by
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

  router.get("/:id", async (req: AuthRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Не авторизован" });
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

  router.get("/:id/messages", async (req: AuthRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Не авторизован" });
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

      await pool.query(
        `DELETE FROM messages
         WHERE type = 'watch_invitation'
         AND created_at < NOW() - INTERVAL '7 days'`,
      );

      const result = await pool.query(
        `SELECT m.id, m.user_id, m.content, m.created_at, m.type, m.video_url, u.username
         FROM messages m
         JOIN users u ON m.user_id = u.id
         WHERE m.chat_id = $1
         ORDER BY m.created_at ASC`,
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

  router.post("/:id/participants", async (req: AuthRequest, res: Response) => {
    const chatId = req.params.id;
    const requesterId = req.user?.userId;
    if (!requesterId) return res.status(401).json({ message: "Не авторизован" });
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

  router.get("/:id/participants", async (req: AuthRequest, res: Response) => {
    const chatId = req.params.id;
    const myId = req.user?.userId;
    if (!myId) return res.status(401).json({ message: "Не авторизован" });

    try {
      const accessCheck = await pool.query(
        "SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2",
        [chatId, myId],
      );
      if (accessCheck.rows.length === 0) {
        return res.status(403).json({ message: "Нет доступа к чату" });
      }

      const result = await pool.query(
        `SELECT u.id, u.username, u.avatar_url,
         CASE WHEN c.created_by = u.id THEN true ELSE false END as is_creator
         FROM users u
         JOIN chat_participants cp ON u.id = cp.user_id
         JOIN chats c ON cp.chat_id = c.id
         WHERE cp.chat_id = $1`,
        [chatId],
      );

      return res.status(200).json({ participants: result.rows });
    } catch (error) {
      console.error("Ошибка получения участников:", error);
      return res.status(500).json({ message: "Ошибка серверера" });
    }
  });

  router.delete("/:id/participants", async (req: AuthRequest, res: Response) => {
    const chatId = req.params.id;
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Не авторизован" });

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const participantCheck = await client.query(
        "SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2",
        [chatId, userId],
      );

      if (participantCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Вы не участник этого чата" });
      }

      await client.query(
        "DELETE FROM chat_participants WHERE chat_id = $1 AND user_id = $2",
        [chatId, userId],
      );

      const remainingParticipants = await client.query(
        "SELECT COUNT(*) as count FROM chat_participants WHERE chat_id = $1",
        [chatId],
      );

      const participantCount = parseInt(remainingParticipants.rows[0].count);

      if (participantCount === 0) {
        await client.query("DELETE FROM chats WHERE id = $1", [chatId]);
        await client.query("COMMIT");
        return res.status(200).json({
          message: "Вы вышли из чата. Чат был удалён, так как в нём не осталось участников",
          chatDeleted: true,
        });
      }

      await client.query("COMMIT");
      return res.status(200).json({
        message: "Вы вышли из чата",
        chatDeleted: false,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Ошибка выхода из чата:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    } finally {
      client.release();
    }
  });

  return router;
};
