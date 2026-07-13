import { Router, Request, Response } from "express";
import { Pool } from "pg";
import { authMiddleware } from "../middleware/auth";

interface AuthRequest extends Request {
  user?: { userId: number; role: string };
}

export const createCatalogRouter = (pool: Pool): Router => {
  const router = Router();
  router.use(authMiddleware);

  router.get("/", async (req: AuthRequest, res: Response) => {
    try {
      const result = await pool.query(
        "SELECT id, title, description, video_url, poster_url, created_at FROM catalog_videos ORDER BY id ASC",
      );
      return res.status(200).json({ videos: result.rows });
    } catch (e) {
      console.error("catalog error:", e);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  return router;
};
