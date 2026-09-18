import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env, isConfigured } from "../config/env.js";
import { pool } from "../db/pool.js";

export interface StoredFile {
  key: string;
  size: number;
}

export interface StorageDriver {
  put(key: string, stream: NodeJS.ReadableStream, contentType?: string): Promise<StoredFile>;
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;
  delete(key: string): Promise<void>;
}

class LocalDiskDriver implements StorageDriver {
  private baseDir = path.resolve(env.storage.localDir);

  async put(key: string, stream: NodeJS.ReadableStream): Promise<StoredFile> {
    const fullPath = path.join(this.baseDir, key);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(fullPath);
      stream.pipe(out);
      stream.on("error", reject);
      out.on("error", reject);
      out.on("finish", () => resolve());
    });
    const st = await stat(fullPath);
    return { key, size: st.size };
  }

  async getSignedUrl(key: string): Promise<string> {
    // Local dev: served via the /files/:token route with a short-lived signed token,
    // not a real filesystem URL (keeps private files private).
    const token = signLocalFileToken(key);
    return `${env.apiUrl.replace(/\/$/, "")}/api/files/local/${token}`;
  }

  async delete(key: string): Promise<void> {
    const fullPath = path.join(this.baseDir, key);
    await unlink(fullPath).catch(() => undefined);
  }

  readStream(key: string) {
    return createReadStream(path.join(this.baseDir, key));
  }
}

class S3CompatibleDriver implements StorageDriver {
  private client: S3Client;
  private bucket: string;

  constructor() {
    if (
      !isConfigured(
        env.storage.s3Bucket,
        env.storage.s3AccessKeyId,
        env.storage.s3SecretAccessKey,
        env.storage.s3Region
      )
    ) {
      throw new Error(
        "S3-compatible storage is not fully configured. Set STORAGE_S3_BUCKET, STORAGE_S3_REGION, STORAGE_S3_ACCESS_KEY_ID and STORAGE_S3_SECRET_ACCESS_KEY (and STORAGE_S3_ENDPOINT for Supabase/MinIO)."
      );
    }
    this.bucket = env.storage.s3Bucket!;
    this.client = new S3Client({
      region: env.storage.s3Region!,
      endpoint: env.storage.s3Endpoint,
      forcePathStyle: env.storage.s3ForcePathStyle,
      credentials: {
        accessKeyId: env.storage.s3AccessKeyId!,
        secretAccessKey: env.storage.s3SecretAccessKey!,
      },
    });
  }

  async put(key: string, stream: NodeJS.ReadableStream, contentType?: string): Promise<StoredFile> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType })
    );
    return { key, size: body.length };
  }

  async getSignedUrl(key: string, expiresInSeconds = 900): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

function signLocalFileToken(key: string): string {
  const exp = Date.now() + 15 * 60 * 1000;
  const payload = `${key}:${exp}`;
  const sig = crypto.createHmac("sha256", requireLocalSigningSecret()).update(payload).digest("hex");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

export function verifyLocalFileToken(token: string): string | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const [key, expStr, sig] = decoded.split(":");
    const exp = Number(expStr);
    if (Date.now() > exp) return null;
    const expected = crypto
      .createHmac("sha256", requireLocalSigningSecret())
      .update(`${key}:${expStr}`)
      .digest("hex");
    if (sig !== expected) return null;
    return key;
  } catch {
    return null;
  }
}

function requireLocalSigningSecret(): string {
  if (!env.credentialsEncryptionKey) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY must be set (also used to sign local file URLs).");
  }
  return env.credentialsEncryptionKey;
}

let driver: StorageDriver | null = null;
export function getStorageDriver(): StorageDriver {
  if (driver) return driver;
  driver = env.storage.driver === "s3" ? new S3CompatibleDriver() : new LocalDiskDriver();
  return driver;
}

export function getLocalDiskDriver(): LocalDiskDriver {
  const d = getStorageDriver();
  if (!(d instanceof LocalDiskDriver)) {
    throw new Error("Local file serving requested but STORAGE_DRIVER is not 'local'.");
  }
  return d;
}

export async function recordFile(params: {
  organizationId: string;
  ownerId?: string;
  key: string;
  fileName: string;
  fileType: string;
  mimeType?: string;
  size: number;
  metadata?: Record<string, unknown>;
}) {
  const result = await pool.query<{ id: string }>(
    `insert into files (organization_id, owner_id, file_path, file_name, file_type, mime_type, file_size, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      params.organizationId,
      params.ownerId ?? null,
      params.key,
      params.fileName,
      params.fileType,
      params.mimeType ?? null,
      params.size,
      JSON.stringify(params.metadata ?? {}),
    ]
  );
  return result.rows[0].id;
}
