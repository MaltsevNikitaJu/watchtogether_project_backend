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
            const query = `
            SELECT c.id, c.name, c.type, c.video_url, c.created_at
            FROM chats c
            INNER JOIN chat_participants cp ON c.id = cp.chat_id
            WHERE cp.user_id = $1
            ORDER BY c.created_at DESC
            `;

            const result = await pool.query(query, [userId]);

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

    return router;
};
