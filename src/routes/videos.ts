import { Router, Request, Response } from "express";
import { Pool } from "pg";
import { HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { authMiddleware } from "../middleware/auth";
import { subscriptionInfoMiddleware } from "../middleware/premium";
import {
  ensureBucket,
  getPresignedUploadUrl,
  getPresignedDownloadUrl,
  s3,
  bucket,
} from "../s3";

interface AuthRequest extends Request {
  user?: { userId: number; role: string };
  subscription?: { plan: string; status: string; is_premium: boolean };
}

const STORAGE_QUOTA_BYTES = 50 * 1024 * 1024 * 1024;

export const createVideosRouter = (pool: Pool): Router => {
  const router = Router();
  router.use(authMiddleware);
  router.use(subscriptionInfoMiddleware(pool));

  const getUserUsage = async (userId: number): Promise<number> => {
    const result = await pool.query(
      "SELECT COALESCE(SUM(size), 0) as used FROM videos WHERE user_id = $1 AND status IN ('ready','uploading')",
      [userId],
    );
    return parseInt(result.rows[0].used, 10);
  };

  router.get("/quota", async (req: AuthRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Не авторизован" });
    try {
      const used = await getUserUsage(userId);
      return res.status(200).json({
        used,
        limit: STORAGE_QUOTA_BYTES,
        is_premium: !!req.subscription?.is_premium,
      });
    } catch (e) {
      console.error("quota error:", e);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.get("/", async (req: AuthRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Не авторизован" });
    try {
      const result = await pool.query(
        "SELECT id, title, size, content_type, status, created_at FROM videos WHERE user_id = $1 ORDER BY created_at DESC",
        [userId],
      );
      return res.status(200).json({ videos: result.rows });
    } catch (e) {
      console.error("list videos error:", e);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.post("/init", async (req: AuthRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Не авторизован" });

    if (!req.subscription?.is_premium) {
      return res.status(403).json({
        message: "Загрузка видео доступна только с Premium",
        require_premium: true,
      });
    }

    const { filename, contentType, size, title } = req.body as {
      filename?: string;
      contentType?: string;
      size?: number;
      title?: string;
    };
    if (!filename || !size || Number(size) <= 0) {
      return res.status(400).json({ message: "Укажите filename и size" });
    }
    const declaredSize = Number(size);
    const videoTitle = title && title.trim() ? title.trim().slice(0, 255) : filename;

    try {
      const used = await getUserUsage(userId);
      if (used + declaredSize > STORAGE_QUOTA_BYTES) {
        const remaining = Math.max(0, STORAGE_QUOTA_BYTES - used);
        return res.status(403).json({
          message: `Превышен лимит хранилища. Свободно: ${(remaining / 1024 ** 3).toFixed(1)} ГБ`,
        });
      }

      await ensureBucket();
      const safeName = filename.replace(/[^\w.\-]/g, "_").slice(0, 80);
      const key = `${userId}/${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}`;
      const uploadUrl = await getPresignedUploadUrl(key, contentType || "video/mp4");

      const insertRes = await pool.query(
        `INSERT INTO videos (user_id, title, s3_key, size, content_type, status)
         VALUES ($1, $2, $3, $4, $5, 'uploading') RETURNING id`,
        [userId, videoTitle, key, declaredSize, contentType || "video/mp4"],
      );

      return res.status(200).json({ uploadUrl, key, videoId: insertRes.rows[0].id });
    } catch (e) {
      console.error("init upload error:", e);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.post("/:id/complete", async (req: AuthRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Не авторизован" });
    const videoId = req.params.id;

    try {
      const videoRes = await pool.query("SELECT * FROM videos WHERE id = $1 AND user_id = $2", [
        videoId,
        userId,
      ]);
      if (videoRes.rows.length === 0) {
        return res.status(404).json({ message: "Видео не найдено" });
      }
      const video = videoRes.rows[0];

      await ensureBucket();
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: video.s3_key }),
      );
      const actualSize = head.ContentLength ?? 0;
      if (actualSize <= 0) {
        return res.status(400).json({ message: "Файл не найден в хранилище" });
      }

      await pool.query("UPDATE videos SET status = 'ready', size = $1 WHERE id = $2", [
        actualSize,
        videoId,
      ]);
      return res.status(200).json({ id: videoId, size: actualSize, status: "ready" });
    } catch (e) {
      console.error("complete upload error:", e);
      await pool.query("UPDATE videos SET status = 'error' WHERE id = $1", [videoId]);
      return res.status(500).json({ message: "Не удалось подтвердить загрузку" });
    }
  });

  router.delete("/:id", async (req: AuthRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Не авторизован" });
    const videoId = req.params.id;

    try {
      const videoRes = await pool.query("SELECT * FROM videos WHERE id = $1 AND user_id = $2", [
        videoId,
        userId,
      ]);
      if (videoRes.rows.length === 0) {
        return res.status(404).json({ message: "Видео не найдено" });
      }
      const video = videoRes.rows[0];

      try {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: video.s3_key }));
      } catch (e) {
        console.warn("Не удалось удалить объект из S3:", e);
      }

      await pool.query("DELETE FROM videos WHERE id = $1", [videoId]);
      return res.status(200).json({ message: "Видео удалено" });
    } catch (e) {
      console.error("delete video error:", e);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  router.get("/:id/play-url", async (req: AuthRequest, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Не авторизован" });
    const videoId = req.params.id;

    try {
      const videoRes = await pool.query(
        "SELECT * FROM videos WHERE id = $1 AND user_id = $2 AND status = 'ready'",
        [videoId, userId],
      );
      if (videoRes.rows.length === 0) {
        return res.status(404).json({ message: "Видео не найдено" });
      }
      const url = await getPresignedDownloadUrl(videoRes.rows[0].s3_key);
      return res.status(200).json({ url });
    } catch (e) {
      console.error("play-url error:", e);
      return res.status(500).json({ message: "Ошибка сервера" });
    }
  });

  return router;
};
