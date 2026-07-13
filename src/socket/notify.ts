import type { Server } from "socket.io";

let io: Server | null = null;
const userSockets = new Map<number, Set<string>>();

export const setIo = (server: Server) => {
    io = server;
};

export const registerUserSocket = (userId: number, socketId: string) => {
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId)!.add(socketId);
};

export const unregisterUserSocket = (userId: number, socketId: string) => {
    const set = userSockets.get(userId);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) userSockets.delete(userId);
};

export const invalidateUser = (userId: number, tags: string[]) => {
    if (!io) return;
    const set = userSockets.get(userId);
    if (!set) return;
    for (const socketId of set) {
        io.to(socketId).emit("cache_invalidated", { tags });
    }
};

export const invalidateRoom = (room: string, tags: string[]) => {
    io?.to(room).emit("cache_invalidated", { tags });
};
