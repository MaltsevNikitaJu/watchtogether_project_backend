import { Server, Socket } from "socket.io";
import { Pool } from "pg";
import jwt from "jsonwebtoken";
import { redisClient } from "../index";
import { setIo, registerUserSocket, unregisterUserSocket } from "./notify";

declare module "socket.io" {
  interface Socket {
    user?: {
      userId: number;
      role: string;
    };
  }
}

export const initializeSocket = (io: Server, pool: Pool) => {
  setIo(io);
  const onlineUsersPerChat = new Map<string, Set<number>>();

  setInterval(() => {
    for (const [chatId, onlineUsers] of onlineUsersPerChat.entries()) {
      if (onlineUsers.size > 0) {
        const room = io.of("/").adapter.rooms.get(`chat_${chatId}`);
        const activeSockets = room ? room.size : 0;

        if (activeSockets < onlineUsers.size) {
          const connectedSockets = new Set<string>();
          if (room) {
            for (const socketId of room) {
              const socket = io.of("/").sockets.get(socketId);
              if (socket?.user?.userId) {
                connectedSockets.add(String(socket.user.userId));
              }
            }
          }

          const cleanedUsers = new Set<number>();
          for (const userId of onlineUsers) {
            if (connectedSockets.has(String(userId))) {
              cleanedUsers.add(userId);
            }
          }

          onlineUsersPerChat.set(chatId, cleanedUsers);

          io.in(`chat_${chatId}`).emit("chat_info", {
            onlineCount: cleanedUsers.size,
          });
        }
      }
    }
  }, 2 * 60 * 1000);

  io.on("connection", (socket: Socket) => {

    const token = socket.handshake.auth.token;

    if (!token) {
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
    } catch (error) {
      socket.emit("error", { message: "Невалидный токен" });
      socket.disconnect(true);
      return;
    }

    registerUserSocket(socket.user.userId, socket.id);
    socket.on("disconnect", () => {
      unregisterUserSocket(socket.user?.userId ?? 0, socket.id);
    });

    socket.on("join_chat", async (chatId: string) => {
      const userId = socket.user?.userId;
      if (!userId) {
        socket.emit("error", { message: "Необходима авторизация" });
        return;
      }

      try {
        const accessCheck = await pool.query(
          "SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2",
          [chatId, userId],
        );
        if (accessCheck.rows.length === 0) {
          socket.emit("error", { message: "Нет доступа к этому чату" });
          return;
        }

        const participantsResult = await pool.query(
          "SELECT user_id FROM chat_participants WHERE chat_id = $1",
          [chatId],
        );

        if (!onlineUsersPerChat.has(chatId)) {
          onlineUsersPerChat.set(chatId, new Set());
        }
        onlineUsersPerChat.get(chatId)!.add(userId);

        const onlineCount = onlineUsersPerChat.get(chatId)!.size;

        socket.emit("chat_info", {
          onlineCount,
          totalParticipants: participantsResult.rows.length,
        });

      } catch (err) {
        console.error("Ошибка проверки доступа к чату:", err);
        socket.emit("error", { message: "Ошибка проверки доступа" });
        return;
      }

      socket.join(`chat_${chatId}`);

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
      const userId = socket.user?.userId;
      if (userId) {
        const chatUsers = onlineUsersPerChat.get(chatId);
        if (chatUsers) {
          chatUsers.delete(userId);
          if (chatUsers.size === 0) {
            onlineUsersPerChat.delete(chatId);
          } else {
            io.in(`chat_${chatId}`).emit("chat_info", {
              onlineCount: chatUsers.size,
            });
          }
        }
      }
      socket.leave(`chat_${chatId}`);
    });

    socket.on("send_message", async (data: { chatId: string; content: string }) => {
      const { chatId, content } = data;
      const userId = socket.user?.userId;

      if (!userId || !content?.trim()) return;

      if (content.length > 5000) {
        socket.emit("error", { message: "Сообщение слишком длинное (максимум 5000 символов)" });
        return;
      }

      try {
        const accessCheck = await pool.query(
          "SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2",
          [chatId, userId],
        );
        if (accessCheck.rows.length === 0) {
          socket.emit("error", { message: "Нет доступа к этому чату" });
          return;
        }

        const result = await pool.query(
          "INSERT INTO messages (chat_id, user_id, content, type) VALUES ($1, $2, $3, $4) RETURNING id, content, created_at",
          [chatId, userId, content, "text"],
        );

        const savedMessage = result.rows[0];
        const userResult = await pool.query(
          "SELECT username, avatar_url FROM users WHERE id = $1",
          [userId],
        );
        const author = userResult.rows[0];

        const messagePayload = {
          id: savedMessage.id,
          chat_id: chatId,
          user_id: userId,
          username: author.username,
          avatar_url: author.avatar_url,
          content: savedMessage.content,
          created_at: savedMessage.created_at,
          type: "text",
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

      try {
        const accessCheck = await pool.query(
          "SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2",
          [chatId, userId],
        );
        if (accessCheck.rows.length === 0) {
          socket.emit("error", { message: "Нет доступа к этому чату" });
          return;
        }

        const chatRow = await pool.query(
          "SELECT created_by, host_only_controls FROM chats WHERE id = $1",
          [chatId],
        );
        if (chatRow.rows.length > 0) {
          const chat = chatRow.rows[0];
          if (chat.host_only_controls && chat.created_by !== userId) {
            socket.emit("error", { message: "Управление видео доступно только ведущему" });
            return;
          }
        }

        const payload = { action, time, userId };
        socket.to(`chat_${chatId}`).emit("sync_video", payload);

        await redisClient.set(
          `room:${chatId}:video_state`,
          JSON.stringify({ action, time }),
          "EX",
          86400,
        );

        const userResult = await pool.query(
          "SELECT username FROM users WHERE id = $1",
          [userId],
        );
        const username = userResult.rows[0]?.username;

        if (username) {
          let systemMessage = '';
          const timeStr = new Date(time * 1000).toISOString().substring(14, 19);

          switch (action) {
            case 'play':
              systemMessage = `${username} включил видео`;
              break;
            case 'pause':
              systemMessage = `${username} поставил видео на паузу`;
              break;
            case 'seek':
              systemMessage = `${username} перемотал видео на ${timeStr}`;
              break;
          }

          if (systemMessage) {
            const messageResult = await pool.query(
              "INSERT INTO messages (chat_id, user_id, content, type) VALUES ($1, $2, $3, $4) RETURNING id, content, created_at",
              [chatId, userId, systemMessage, "system"],
            );

            const systemMessagePayload = {
              id: messageResult.rows[0].id,
              chat_id: chatId,
              user_id: userId,
              username,
              content: systemMessage,
              created_at: messageResult.rows[0].created_at,
              type: "system",
            };

            io.in(`chat_${chatId}`).emit("receive_message", systemMessagePayload);
          }
        }
      } catch (err) {
        console.error("Ошибка при отправке системного сообщения:", err);
      }
    });

    socket.on("send_watch_invitation", async (data: { chatId: string; videoUrl: string; username: string }) => {
      const { chatId, videoUrl, username } = data;
      const userId = socket.user?.userId;

      if (!userId || !chatId || !videoUrl) return;

      try {
        const accessCheck = await pool.query(
          "SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2",
          [chatId, userId],
        );
        if (accessCheck.rows.length === 0) {
          socket.emit("error", { message: "Нет доступа к этому чату" });
          return;
        }

        await pool.query(
          "DELETE FROM messages WHERE chat_id = $1 AND user_id = $2 AND type = 'watch_invitation'",
          [chatId, userId],
        );

        const messageResult = await pool.query(
          "INSERT INTO messages (chat_id, user_id, content, type, video_url) VALUES ($1, $2, $3, $4, $5) RETURNING id, content, created_at",
          [chatId, userId, `🎬 ${username} приглашает вас посмотреть видео вместе!`, "watch_invitation", videoUrl],
        );

        const invitationMessage = {
          id: messageResult.rows[0].id,
          chat_id: chatId,
          user_id: userId,
          username,
          content: `🎬 ${username} приглашает вас посмотреть видео вместе!`,
          created_at: messageResult.rows[0].created_at,
          type: "watch_invitation",
          video_url: videoUrl,
        };

        io.in(`chat_${chatId}`).emit("receive_message", invitationMessage);

        socket.emit("invitation_sent", {
          success: true,
          chatId,
          message: "Приглашение отправлено!",
        });

      } catch (err) {
        console.error("Ошибка при отправке приглашения:", err);
        socket.emit("error", { message: "Ошибка при отправке приглашения" });
      }
    });

    socket.on("chat_settings_changed", async (data: { chatId: string; host_only_controls: boolean }) => {
      const { chatId, host_only_controls } = data;
      const userId = socket.user?.userId;
      if (!userId || !chatId) return;

      try {
        const chatResult = await pool.query("SELECT created_by FROM chats WHERE id = $1", [chatId]);
        if (chatResult.rows.length === 0) return;
        if (chatResult.rows[0].created_by !== userId) {
          socket.emit("error", { message: "Только создатель может менять настройки чата" });
          return;
        }

        io.in(`chat_${chatId}`).emit("chat_settings_updated", { chatId, host_only_controls });

        const userResult = await pool.query("SELECT username FROM users WHERE id = $1", [userId]);
        const username = userResult.rows[0]?.username;
        if (username) {
          const systemMessage = host_only_controls
            ? `${username} включил режим «только ведущий»`
            : `${username} выключил режим «только ведущий»`;

          const messageResult = await pool.query(
            "INSERT INTO messages (chat_id, user_id, content, type) VALUES ($1, $2, $3, $4) RETURNING id, created_at",
            [chatId, userId, systemMessage, "system"],
          );

          io.in(`chat_${chatId}`).emit("receive_message", {
            id: messageResult.rows[0].id,
            chat_id: chatId,
            user_id: userId,
            username,
            content: systemMessage,
            created_at: messageResult.rows[0].created_at,
            type: "system",
          });
        }
      } catch (err) {
        console.error("Ошибка обновления настроек чата:", err);
      }
    });

    socket.on("send_reaction", async (data: { chatId: string; emoji: string }) => {
      const { chatId, emoji } = data;
      const userId = socket.user?.userId;
      if (!userId || !chatId || !emoji) return;
      try {
        const accessCheck = await pool.query(
          "SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2",
          [chatId, userId],
        );
        if (accessCheck.rows.length === 0) return;
        socket.to(`chat_${chatId}`).emit("reaction", { emoji });
      } catch {}
    });
  });
};
