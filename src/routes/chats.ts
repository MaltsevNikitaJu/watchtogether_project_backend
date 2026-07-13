import { Router, Response, Request } from "express";
import { Pool } from "pg";
import { authMiddleware } from "../middleware/auth";
import { subscriptionInfoMiddleware } from "../middleware/premium";
import { invalidateUser, invalidateRoom } from "../socket/notify";

interface AuthRequest extends Request {
  user?: {
    userId: number;
    role: string;
  };
}

export const createChatRoutes = (pool: Pool): Router => {
  const router = Router();

  router.use(authMiddleware);

  router.post("/", subscriptionInfoMiddleware(pool), async (req: AuthRequest, res: Response) => {
    const creatorId = req.user!.userId;
    const { name, type, allow_video } = req.body;

    if (!name) {
      return res.status(400).json({
        message: "Название чата обязательно",
      });
    }

    const chatType = type || "private";
    const allowVideo = allow_video === undefined ? true : Boolean(allow_video);

    if (chatType === 'group') {
      const subscription = req.subscription;
      if (!subscription || !subscription.is_premium) {
        return res.status(403).json({
          message: "Создание групповых чатов доступно только для Premium пользователей",
          require_premium: true,
          current_plan: subscription?.plan || 'free'
        });
      }

      try {
        const existingGroupsResult = await pool.query(
          `SELECT COUNT(*) as count FROM chats c
           INNER JOIN chat_participants cp ON c.id = cp.chat_id
           WHERE cp.user_id = $1 AND c.type = 'group'`,
          [creatorId]
        );

        const groupCount = parseInt(existingGroupsResult.rows[0].count);

        if (subscription.plan === 'premium' && groupCount >= 5) {
          return res.status(403).json({
            message: "Достигнут лимит групповых чатов (5). Оформите Premium+ для безлимита",
            limit_reached: true,
            current_limit: 5,
            require_premium_plus: true
          });
        }
      } catch (error) {
        console.error("Ошибка проверки количества чатов:", error);
      }
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const chatResult = await client.query(
        "INSERT INTO chats (name, type, created_by, allow_video) VALUES ($1, $2, $3, $4) RETURNING *",
        [name, chatType, creatorId, allowVideo],
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
        `SELECT c.id, c.name, c.type, c.video_url, c.created_at, c.created_by, c.host_only_controls, c.allow_video
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

  router.post("/:id/join", async (req: AuthRequest, res: Response) => {
    const chatId = req.params.id;
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Не авторизован" });

    try {
      const chatRes = await pool.query("SELECT type FROM chats WHERE id = $1", [chatId]);
      if (chatRes.rows.length === 0) {
        return res.status(404).json({ message: "Чат не найден" });
      }
      if (chatRes.rows[0].type !== "group") {
        return res.status(403).json({ message: "Это личный чат — вступление по ссылке невозможно" });
      }

      const member = await pool.query(
        "SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2",
        [chatId, userId],
      );
      if (member.rows.length > 0) {
        return res.status(200).json({ message: "Вы уже участник чата" });
      }

      const countRes = await pool.query(
        "SELECT COUNT(*)::int as count FROM chat_participants WHERE chat_id = $1",
        [chatId],
      );
      if (countRes.rows[0].count >= 50) {
        return res.status(403).json({ message: "В чате достигнут лимит участников (50)" });
      }

      await pool.query(
        "INSERT INTO chat_participants (chat_id, user_id) VALUES ($1, $2)",
        [chatId, userId],
      );
      invalidateRoom(`chat_${chatId}`, ["ChatParticipants"]);
      return res.status(200).json({ message: "Вы вступили в чат" });
    } catch (error) {
      console.error("Ошибка вступления в чат:", error);
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
        `SELECT m.id, m.user_id, m.content, m.created_at, m.type, m.video_url, u.username, u.avatar_url
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

  router.post("/:id/participants", subscriptionInfoMiddleware(pool), async (req: AuthRequest, res: Response) => {
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

      const participantsCountResult = await pool.query(
        "SELECT COUNT(*) as count FROM chat_participants WHERE chat_id = $1",
        [chatId]
      );

      const currentCount = parseInt(participantsCountResult.rows[0].count);
      const subscription = req.subscription;
      const newCount = currentCount + 1;

      const chatInfo = await pool.query("SELECT type FROM chats WHERE id = $1", [chatId]);
      const chatType = chatInfo.rows[0]?.type || "private";

      if (chatType === "private" && newCount > 2) {
        return res.status(403).json({
          message: "Личный чат рассчитан на двоих. Для большего числа участников создайте групповой чат.",
          limit: 2,
          current_count: currentCount,
        });
      }

      if (chatType === "group") {
        if (!subscription || !subscription.is_premium) {
          return res.status(403).json({
            message: "Для добавления участников в групповой чат требуется Premium",
            require_premium: true,
            current_plan: subscription?.plan || "free",
          });
        }
        if (newCount > 50) {
          return res.status(403).json({
            message: "Достигнут лимит участников (50)",
            limit_reached: true,
            current_count: currentCount,
            limit: 50,
          });
        }
      }

      await pool.query(
        "INSERT INTO chat_participants (chat_id, user_id) VALUES ($1, $2)",
        [chatId, userId],
      );

      invalidateUser(userId, ["Chats"]);
      invalidateRoom(`chat_${chatId}`, ["ChatParticipants"]);

      return res.status(201).json({
        message: "Участник успешно добавлен",
        current_participants: newCount
      });
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
      invalidateRoom(`chat_${chatId}`, ["ChatParticipants"]);
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

  router.patch("/:id", async (req: AuthRequest, res: Response) => {
    const chatId = req.params.id;
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Не авторизован" });

    try {
      const chatResult = await pool.query("SELECT * FROM chats WHERE id = $1", [chatId]);
      if (chatResult.rows.length === 0) {
        return res.status(404).json({ message: "Чат не найден" });
      }
      const chat = chatResult.rows[0];
      if (chat.created_by !== userId) {
        return res.status(403).json({ message: "Только создатель может изменять настройки чата" });
      }

      const { name, host_only_controls, allow_video } = req.body;
      const updates: string[] = [];
      const values: (string | number | boolean)[] = [];
      let paramIndex = 1;

      if (name !== undefined) {
        if (typeof name !== "string" || name.trim().length === 0 || name.length > 100) {
          return res.status(400).json({ message: "Название чата должно быть от 1 до 100 символов" });
        }
        updates.push(`name = $${paramIndex++}`);
        values.push(name.trim());
      }
      if (host_only_controls !== undefined) {
        updates.push(`host_only_controls = $${paramIndex++}`);
        values.push(Boolean(host_only_controls));
      }
      if (allow_video !== undefined) {
        updates.push(`allow_video = $${paramIndex++}`);
        values.push(Boolean(allow_video));
      }

      if (updates.length === 0) {
        return res.status(400).json({ message: "Нет данных для обновления" });
      }

      values.push(String(chatId));
      const result = await pool.query(
        `UPDATE chats SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
        values,
      );

      return res.status(200).json({ chat: result.rows[0] });
    } catch (error) {
      console.error("Ошибка обновления чата:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.get("/:id/settings", async (req: AuthRequest, res: Response) => {
    const chatId = req.params.id;
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Не авторизован" });

    try {
      const result = await pool.query(
        `SELECT notify_messages, notify_video, sound_enabled, show_participants
         FROM chat_participants WHERE chat_id = $1 AND user_id = $2`,
        [chatId, userId],
      );
      if (result.rows.length === 0) {
        return res.status(403).json({ message: "Нет доступа к чату" });
      }
      return res.status(200).json({ settings: result.rows[0] });
    } catch (error) {
      console.error("Ошибка получения настроек:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.patch("/:id/settings", async (req: AuthRequest, res: Response) => {
    const chatId = req.params.id;
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Не авторизован" });

    const { notify_messages, notify_video, sound_enabled, show_participants } = req.body;
    const fields: Record<string, unknown> = { notify_messages, notify_video, sound_enabled, show_participants };

    const updates: string[] = [];
    const values: (string | number | boolean)[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        updates.push(`${key} = $${paramIndex++}`);
        values.push(Boolean(value));
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ message: "Нет данных для обновления" });
    }

    values.push(String(chatId));
    values.push(userId);

    try {
      const result = await pool.query(
        `UPDATE chat_participants SET ${updates.join(", ")}
         WHERE chat_id = $${paramIndex++} AND user_id = $${paramIndex}
         RETURNING notify_messages, notify_video, sound_enabled, show_participants`,
        values,
      );
      if (result.rows.length === 0) {
        return res.status(403).json({ message: "Нет доступа к чату" });
      }
      return res.status(200).json({ settings: result.rows[0] });
    } catch (error) {
      console.error("Ошибка обновления настроек:", error);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  return router;
};
