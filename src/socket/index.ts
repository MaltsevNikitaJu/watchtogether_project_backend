import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';

declare module 'socket.io' {
    interface Socket {
        user?: {
            userId: number;
            role: string;
        }
    }
}

export const initializeSocket = (io: Server) => {

    io.on('connection', (socket: Socket) => {
        console.log(`Подключение: ${socket.id}`);

        const token = socket.handshake.auth.token;

        if (!token) {
            console.log(`Отключение ${socket.id}: нет токена`);

            socket.emit('error', { message: 'Необходима авторизация' });

            socket.disconnect(true);

            return;
        }

        try {
            const secret = process.env.JWT_SECRET;

            if (!secret) {
                throw new Error('Нет секрета');
            }

            const decoded = jwt.verify(token, secret) as {
                userId: number;
                role: string
            };

            socket.user = decoded;

            console.log(`Пользователь ${socket.user.userId} авторизован через сокет`);
        } catch (error) {
            console.log(`Отключение ${socket.id}, невалидный токен`);

            socket.emit('error', { message: 'Невалидный токен' });

            socket.disconnect(true);

            return;
        }

        socket.on('join_chat', (chatId: string) => {
            socket.join(`chat_${chatId}`);

            console.log(`Пользователь ${socket.user?.userId} зашел в комнату chat_${chatId}`);

            socket.emit('joined_chat', { chatId });
        });

        socket.on('leave_chat', (chatId: string) => {
            socket.leave(`chat_${chatId}`);

            console.log(`Пользователь ${socket.user?.userId} вышел из комнаты chat_${chatId}`);

        });

        socket.on('disconnect', () => {
            console.log(`Пользователь ${socket.user?.userId || socket.id} отключился`);
        });
    });
};