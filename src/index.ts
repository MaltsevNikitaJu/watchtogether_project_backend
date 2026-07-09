import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Pool } from "pg";
import { createServer } from "http";
import { Server } from "socket.io";
import Redis from "ioredis";
import path from "path";

import { createAuthRouter } from "./routes/auth";
import { createChatRoutes } from "./routes/chats";
import { createUserRoutes } from "./routes/users";
import { createSubscriptionRoutes } from "./routes/subscriptions";
import { createYandexAuthRouter } from "./routes/oauth";
import { createVideosRouter } from "./routes/videos";
import { createCatalogRouter } from "./routes/catalog";
import { initializeSocket } from "./socket";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

export const redisClient = new Redis(
  process.env.REDIS_URL || "redis://localhost:6379",
);

redisClient.on("connect", () => {
});

redisClient.on("error", (error) => {
  console.error("Ошибка при подключении редиса", error);
});

initializeSocket(io, pool);

async function checkDatabaseConnection() {
  try {
    const client = await pool.connect();
    client.release();
  } catch (err) {
    console.error("Ошибка при подключении к бд", err);
  }
}

app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
}));
app.use(express.json({ limit: '1mb' }));

app.use('/uploads', express.static(path.join(process.cwd(), 'uploads'), {
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || "http://localhost:5173");
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}));

app.use("/api/auth", createAuthRouter(pool));
app.use("/api/auth", createYandexAuthRouter(pool));
app.use("/api/chats", createChatRoutes(pool));
app.use("/api/users", createUserRoutes(pool));
app.use("/api/subscriptions", createSubscriptionRoutes(pool));
app.use("/api/videos", createVideosRouter(pool));
app.use("/api/catalog", createCatalogRouter(pool));

app.get("/", (req: Request, res: Response) => {
  res.send("Сервер запущен");
});

httpServer.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  await checkDatabaseConnection();
});
