import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: number;
        role: string;
      };
    }
  }
}

export const authMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers["authorization"];

  if (!authHeader) {
    return res.status(400).json({
      message: "Нет заголовка",
    });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(400).json({
      message: "Нет токена авторизации",
    });
  }

  const secret = process.env.JWT_SECRET;

  if (!secret) {
    return res.status(500).json({
      message: "Ошибка конфигурации сервера",
    });
  }

  jwt.verify(token, secret, (err, decoded) => {
    if (err) {
      return res.status(403).json({
        message: "Токен недействителен или просрочен",
      });
    }

    req.user = decoded as {
      userId: number;
      role: string;
    };
    next();
  });
};
