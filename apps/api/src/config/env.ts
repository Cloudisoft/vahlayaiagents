import "dotenv/config";

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function required(name: string): string {
  const v = optional(name);
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export const env = {
  port: Number(optional("PORT") ?? "4000"),
  nodeEnv: optional("NODE_ENV") ?? "development",
  appUrl: optional("APP_URL") ?? "http://localhost:5173",
  apiUrl: optional("API_URL") ?? `http://localhost:${Number(optional("PORT") ?? "4000")}`,

  databaseUrl: required("DATABASE_URL"),

  jwtSecret: optional("JWT_SECRET"),
  jwtAccessTtl: optional("JWT_ACCESS_TTL") ?? "15m",
  refreshTokenTtlDays: Number(optional("REFRESH_TOKEN_TTL_DAYS") ?? "30"),

  credentialsEncryptionKey: optional("CREDENTIALS_ENCRYPTION_KEY"),

  redisUrl: optional("REDIS_URL"),

  storage: {
    driver: (optional("STORAGE_DRIVER") ?? "local") as "local" | "s3",
    localDir: optional("STORAGE_LOCAL_DIR") ?? "./storage",
    s3Endpoint: optional("STORAGE_S3_ENDPOINT"),
    s3Region: optional("STORAGE_S3_REGION"),
    s3Bucket: optional("STORAGE_S3_BUCKET"),
    s3AccessKeyId: optional("STORAGE_S3_ACCESS_KEY_ID"),
    s3SecretAccessKey: optional("STORAGE_S3_SECRET_ACCESS_KEY"),
    s3ForcePathStyle: (optional("STORAGE_S3_FORCE_PATH_STYLE") ?? "true") === "true",
  },

  openaiApiKey: optional("OPENAI_API_KEY"),

  plivo: {
    authId: optional("PLIVO_AUTH_ID"),
    authToken: optional("PLIVO_AUTH_TOKEN"),
  },
  twilio: {
    accountSid: optional("TWILIO_ACCOUNT_SID"),
    authToken: optional("TWILIO_AUTH_TOKEN"),
    apiKey: optional("TWILIO_API_KEY"),
    apiSecret: optional("TWILIO_API_SECRET"),
  },

  vapiApiKey: optional("VAPI_API_KEY"),
  vapiWebhookSecret: optional("VAPI_WEBHOOK_SECRET"),
  cartesiaApiKey: optional("CARTESIA_API_KEY"),

  googlePlacesApiKey: optional("GOOGLE_PLACES_API_KEY"),

  email: {
    provider: (optional("EMAIL_PROVIDER") ?? "smtp") as "smtp" | "resend",
    smtpHost: optional("SMTP_HOST"),
    smtpPort: Number(optional("SMTP_PORT") ?? "587"),
    smtpUser: optional("SMTP_USER"),
    smtpPass: optional("SMTP_PASS"),
    smtpFrom: optional("SMTP_FROM"),
    resendApiKey: optional("RESEND_API_KEY"),
    resendFrom: optional("RESEND_FROM"),
  },
};

export function isConfigured(...values: Array<string | undefined>): boolean {
  return values.every((v) => v !== undefined && v.length > 0);
}
