import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Pool } from "pg";
import { createServer } from "http";
import { Server } from "socket.io";
import Redis from "ioredis";

import { createAuthRouter } from "./routes/auth";
import { createChatRoutes } from "./routes/chats";
import { createUserRoutes } from "./routes/users";
import { initializeSocket } from "./socket";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

export const redisClient = new Redis(
  process.env.REDIS_URL || "redis://localhost:6379",
);

redisClient.on("connect", () => {
  console.log("Подключен редис");
});

redisClient.on("error", (error) => {
  console.log("Ошибка при подключении редиса", error);
});

initializeSocket(io, pool);

async function checkDatabaseConnection() {
  try {
    const client = await pool.connect();
    console.log("Успешное подключение к бд");
    client.release();
  } catch (err) {
    console.error("Ошибка при подключении к бд", err);
  }
}

app.use(cors());
app.use(express.json());

app.use("/api/auth", createAuthRouter(pool));
app.use("/api/chats", createChatRoutes(pool));
app.use("/api/users", createUserRoutes(pool));

app.get("/", (req: Request, res: Response) => {
  res.send("Сервер запущен");
});

httpServer.listen(PORT, async () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
  await checkDatabaseConnection();
});
