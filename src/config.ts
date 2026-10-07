import dotenv from "dotenv";

dotenv.config();

export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const OWNER_ID = process.env.TELEGRAM_OWNER_ID || "";
export const MONGODB_URI = process.env.MONGODB_URI || "";
export const DB_NAME = process.env.MONGODB_DB_NAME || process.env.DATABASE_NAME || "smm_up_db";

export function validateStartupConfig() {
  if (!BOT_TOKEN) {
    console.error("FATAL: TELEGRAM_BOT_TOKEN is not defined in environment variables.");
    process.exit(1);
  }
  if (!/^\d+$/.test(OWNER_ID.trim())) {
    console.error("FATAL: TELEGRAM_OWNER_ID must be the owner's numeric Telegram user ID.");
    process.exit(1);
  }
  if (!MONGODB_URI) {
    console.error("FATAL: MONGODB_URI is not defined in environment variables.");
    process.exit(1);
  }
}

export function temporaryPasswordTtlMinutes(): number {
  const parsed = Number.parseInt(String(process.env.TEMP_PASSWORD_TTL_MINUTES || "180"), 10);
  return Number.isFinite(parsed) && parsed >= 15 && parsed <= 1440 ? parsed : 180;
}

export function temporaryPasswordMaxUses(): 1 | 2 {
  return Number.parseInt(String(process.env.TEMP_PASSWORD_MAX_USES || "2"), 10) === 1 ? 1 : 2;
}
