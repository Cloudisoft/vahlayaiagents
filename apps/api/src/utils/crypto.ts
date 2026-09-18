import crypto from "node:crypto";
import { env } from "../config/env.js";

const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  if (!env.credentialsEncryptionKey) {
    throw new Error(
      "CREDENTIALS_ENCRYPTION_KEY is not configured. Set a 32-byte base64 key (openssl rand -base64 32) before storing credentials."
    );
  }
  const key = Buffer.from(env.credentialsEncryptionKey, "base64");
  if (key.length !== 32) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptSecret(encoded: string): string {
  const key = getKey();
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
