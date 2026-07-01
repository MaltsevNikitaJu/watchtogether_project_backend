import { Server, Socket } from "socket.io";
import { Pool } from "pg";
import jwt from "jsonwebtoken";
import { redisClient } from "../index";

declare module "socket.io" {
  interface Socket {
    user?: {
      userId: number;
      role: string;
    };
  }
}

export const initializeSocket = (io: Server, pool: Pool) => {
  io.on("connection", (socket: Socket) => {
    console.log(`Подключение: ${socket.id}`);

    const token = socket.handshake.auth.token;

    if (!token) {
      console.log(`Отключение ${socket.id}: нет токена`);
      socket.emit("error", { message: "Необходима авторизация" });
      socket.disconnect(true);
      return;
    }

    try {
      const secret = process.env.JWT_SECRET;
      if (!secret) {
        throw new Error("Нет секрета");
      }

      const decoded = jwt.verify(token, secret) as {
        userId: number;
        role: string;
      };

      socket.user = decoded;
      console.log(`Пользователь ${socket.user.userId} авторизован через сокет`);
    } catch (error) {
      console.log(`Отключение ${socket.id}, невалидный токен`);
      socket.emit("error", { message: "Невалидный токен" });
      socket.disconnect(true);
      return;
    }

    socket.on("join_chat", async (chatId: string) => {
      socket.join(`chat_${chatId}`);
      console.log(`${socket.user?.userId} зашел в комнату chat_${chatId}`);

      try {
        const stateStr = await redisClient.get(`room:${chatId}:video_state`);
        if (stateStr) {
          const state = JSON.parse(stateStr);
          socket.emit("initial_video_state", state);
        }
      } catch (err) {
        console.error("Ошибка чтения из Redis:", err);
      }

      socket.emit("joined_chat", { chatId });
    });

    socket.on("leave_chat", (chatId: string) => {
      socket.leave(`chat_${chatId}`);
      console.log(
        `Пользователь ${socket.user?.userId} вышел из комнаты chat_${chatId}`,
      );
    });

    socket.on("send_message", async (data: { chatId: string; content: string }) => {
      const { chatId, content } = data;
      const userId = socket.user?.userId;

      if (!userId || !content.trim()) return;

      try {
        const result = await pool.query(
          "INSERT INTO messages (chat_id, user_id, content, type) VALUES ($1, $2, $3, $4) RETURNING id, content, created_at",
          [chatId, userId, content, "text"],
        );

        const savedMessage = result.rows[0];
        const userResult = await pool.query(
          "SELECT username FROM users WHERE id = $1",
          [userId],
        );
        const username = userResult.rows[0].username;

        const messagePayload = {
          id: savedMessage,
          chatId: chatId,
          userId: userId,
          username: username,
          content: savedMessage.content,
          created_at: savedMessage.created_at,
        };

        io.in(`chat_${chatId}`).emit("receive_message", messagePayload);
      } catch (error) {
        console.error("Ошибка сохранения сообщения", error);
      }
    });

    socket.on("video_action", async (data: { chatId: string; action: string; time: number }) => {
      const { chatId, action, time } = data;
      const userId = socket.user?.userId;

      if (!userId || !chatId) return;

      const payload = { action, time, userId };
      socket.to(`chat_${chatId}`).emit("sync_video", payload);

      try {
        await redisClient.set(
          `room:${chatId}:video_state`,
          JSON.stringify({ action, time }),
          "EX",
          86400,
        );
      } catch (err) {
        console.error("Ошибка записи в Redis:", err);
      }
    });

    socket.on("disconnect", () => {
      console.log(
        `Пользователь ${socket.user?.userId || socket.id} отключился`,
      );
    });
  });
};
