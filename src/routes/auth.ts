import { Router, Request, Response } from "express";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { authMiddleware } from "../middleware/auth";

export const createAuthRouter = (pool: Pool): Router => {
    const router = Router();

    router.post("/register", async (req: Request, res: Response) => {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res
                .status(400)
                .json({ message: "Все поля обязательны для заполнения" });
        }
        try {
            const checkUser = await pool.query(
                "SELECT id FROM users WHERE email = $1 OR username = $2",
                [email, username],
            );

            if (checkUser.rows.length > 0) {
                return res.status(400).json({ message: "Пользователь уже существует" });
            }

            const saltRounds = 10;
            const passwordHash = await bcrypt.hash(password, saltRounds);

            const result = await pool.query(
                "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, role",
                [username, email, passwordHash],
            );

            const newUser = result.rows[0];

            return res.status(201).json({
                message: "Успешная регистрация",
                user: {
                    id: newUser.id,
                    username: newUser.username,
                    email: newUser.email,
                    role: newUser.role,
                },
            });
        } catch (error) {
            console.error("Ошибка при регистрации:", error);
            return res.status(500).json({
                message: "Внутренняя ошибка сервера",
            });
        }
    });


    router.post("/login", async (req: Request, res: Response) => {
        const {email, password} = req.body;

        if (!email || !password) {
            return res.status(400).json({message:"Поля обязательны для заполнения"})
        }

        try {
            const result = await pool.query(
                'SELECT * FROM users WHERE email = $1',
                [email]
            )

            if (result.rows.length === 0) {
                return res.status(401).json({message:"Неверный email или пароль"});
            }

            const user = result.rows[0];

            const passwordMatch = await bcrypt.compare(password, user.password_hash);

            if (!passwordMatch) {
                return res.status(401).json({message:"Неверный email или пароль"});
            }

            const payload = {
                userId: user.id,
                role: user.role
            };

            const secret = process.env.JWT_SECRET;

            if (!secret) {
                throw new Error ('JWT_SECRET не найден в .env')
            }

            const token = jwt.sign(payload, secret, {expiresIn: '24h'})

            return res.status(200).json({
                message: 'Вход выполнен успешно',
                token: token,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    role: user.role
                }
            });
        } catch (error) {
            console.error('Ошибка при входе:', error);
            return res.status(500).json({
                message: 'Внутренняя ошибка сервера'
            });
        }
    });

    router.get('/me', authMiddleware, async ( req: Request, res: Response) => {
        try {
            const userId = req.user!.userId;

            const result = await pool.query(
                'SELECT id, username, email, role, avatar_url, created_at FROM users WHERE id = $1',
                [userId]
            );

            if ( result.rows.length === 0) {
                return res.status(400).json({
                    message: 'Пользователь не найден'
                });
            }

            return res.status(200).json({
                user: result.rows[0]
            });

        } catch (error) {
            console.error('Ошибка при получении информации', error);
            return res.status(500).json({
                message: 'Внутренняя ошибка сервера'
            })
        };
    });

    return router;
};
