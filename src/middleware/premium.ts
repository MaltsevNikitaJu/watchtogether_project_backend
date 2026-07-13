import { Request, Response, NextFunction } from "express";
import { Pool } from "pg";

declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: number;
        role: string;
      };
      subscription?: {
        plan: string;
        status: string;
        is_premium: boolean;
      };
    }
  }
}

export const expireIfNeeded = async (pool: Pool, userId: number): Promise<void> => {
  try {
    const found = await pool.query(
      `SELECT id FROM subscriptions
       WHERE user_id = $1 AND plan != 'free' AND status IN ('active', 'cancelled')
         AND end_date IS NOT NULL AND end_date < CURRENT_TIMESTAMP
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    if (found.rows.length === 0) return;

    await pool.query("UPDATE subscriptions SET status = 'expired' WHERE id = $1", [
      found.rows[0].id,
    ]);
    await pool.query(
      "UPDATE users SET role = 'user' WHERE id = $1 AND role IN ('premium', 'premium_plus')",
      [userId],
    );
  } catch (error) {
    console.error("Ошибка проверки истечения подписки:", error);
  }
};

export const subscriptionInfoMiddleware = (pool: Pool) => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const userId = req.user?.userId;
    if (!userId) {
      return next();
    }

    try {
      await expireIfNeeded(pool, userId);

      const result = await pool.query(
        `SELECT s.*,
          CASE
            WHEN s.plan != 'free' AND s.status IN ('active', 'cancelled') AND
            (s.end_date IS NULL OR s.end_date > CURRENT_TIMESTAMP) THEN true
            ELSE false
          END as is_premium
         FROM subscriptions s
         WHERE s.user_id = $1
         ORDER BY s.created_at DESC
         LIMIT 1`,
        [userId]
      );

      if (result.rows.length === 0) {
        req.subscription = {
          plan: 'free',
          status: 'active',
          is_premium: false
        };
      } else {
        const subscription = result.rows[0];
        req.subscription = {
          plan: subscription.plan,
          status: subscription.status,
          is_premium: subscription.is_premium
        };
      }

      next();
    } catch (error) {
      console.error("Ошибка получения информации о подписке:", error);
      next();
    }
  };
};
