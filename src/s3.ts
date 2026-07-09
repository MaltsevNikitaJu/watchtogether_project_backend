import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const endpoint = process.env.S3_ENDPOINT || "http://localhost:9000";
const region = process.env.S3_REGION || "us-east-1";
const accessKey = process.env.S3_ACCESS_KEY || "minioadmin";
const secretKey = process.env.S3_SECRET_KEY || "minioadmin";
const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

export const bucket = process.env.S3_BUCKET || "watchtogether-videos";

export const s3 = new S3Client({
  endpoint,
  region,
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  forcePathStyle: true,
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

let bucketReady = false;

export const ensureBucket = async (): Promise<void> => {
  if (bucketReady) return;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }

  try {
    await s3.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [frontendUrl, "http://localhost:5173", "http://127.0.0.1:5173"],
              AllowedMethods: ["GET", "PUT", "HEAD", "DELETE"],
              AllowedHeaders: ["*"],
              ExposeHeaders: ["ETag", "Content-Length", "Content-Range"],
            },
          ],
        },
      }),
    );
  } catch (e) {
    console.warn("Не удалось настроить bucket CORS (продолжаем):", (e as Error).message);
  }

  bucketReady = true;
};

export const getPresignedUploadUrl = async (
  key: string,
  contentType: string,
  expiresIn = 3600,
): Promise<string> => {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn },
  );
};

export const getPresignedDownloadUrl = async (key: string, expiresIn = 7200): Promise<string> => {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
};
