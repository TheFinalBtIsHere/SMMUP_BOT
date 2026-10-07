import crypto from "crypto";
import bcrypt from "bcryptjs";
import type { Db } from "mongodb";
import { ensureAdminControlIndexes } from "../db/indexes.js";
import { encryptAdminStateSecret, hashActionToken } from "../security/adminState.js";

type RecoveryUser = {
  _id: any;
  email: string;
  username?: string | null;
  account_locked?: boolean;
};
type ProtectedPassword = {
  passwordHash: string;
  passwordEncrypted: ReturnType<typeof encryptAdminStateSecret>;
};

export function validateCustomTemporaryPassword(value: string): string | null {
  if (value.length < 10 || value.length > 128) return "A custom temporary password must be 10–128 characters.";
  const categories = [/[a-z]/.test(value), /[A-Z]/.test(value), /\d/.test(value), /[^A-Za-z0-9]/.test(value)]
    .filter(Boolean).length;
  if (categories < 3) return "Custom temporary password must use at least three character categories.";
  return null;
}

export async function protectCustomTemporaryPassword(value: string): Promise<ProtectedPassword> {
  const error = validateCustomTemporaryPassword(value);
  if (error) throw new Error(error);
  const [passwordHash, passwordEncrypted] = await Promise.all([
    bcrypt.hash(value, 12),
    Promise.resolve(encryptAdminStateSecret(value)),
  ]);
  return { passwordHash, passwordEncrypted };
}

export async function createPasswordResetAction(
  database: Db,
  input: {
    user: RecoveryUser;
    actorTelegramId: number;
    reason: string;
    generated: boolean;
    protectedPassword?: ProtectedPassword | null;
  },
) {
  const rawActionToken = crypto.randomBytes(16).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60_000);
  await ensureAdminControlIndexes(database);
  await database.collection("admin_action_tokens").insertOne({
    token_hash: hashActionToken(rawActionToken),
    action: "password_reset",
    actor_telegram_id: input.actorTelegramId,
    user_id: input.user._id,
    user_email: input.user.email,
    username: input.user.username || null,
    mode: input.generated ? "generated" : "owner_selected",
    custom_password_hash: input.generated ? null : input.protectedPassword?.passwordHash || null,
    custom_password_encrypted: input.generated ? null : input.protectedPassword?.passwordEncrypted || null,
    reason: input.reason,
    created_at: now,
    expires_at: expiresAt,
    consumed_at: null,
    cancelled_at: null,
  });
  return { rawActionToken, expiresAt };
}

export async function issueSupportAccessCode(
  database: Db,
  input: {
    user: RecoveryUser;
    actorTelegramId: number;
    reason: string;
  },
) {
  const user = input.user;
  if ((user as any).account_locked === true) throw new Error("Support Access is unavailable while this account is locked.");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const part = () => Array.from({ length: 4 }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join("");
  const rawCode = `SUP-${part()}-${part()}-${part()}-${part()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60_000);
  const codes = database.collection("support_access_codes");

  await Promise.all([
    codes.createIndex({ code_hash: 1 }, { unique: true }),
    codes.createIndex(
      { subject_user_id: 1 },
      {
        unique: true,
        partialFilterExpression: { consumed_at: null, invalidated_at: null },
        name: "one_active_support_code_per_subject",
      },
    ),
    codes.createIndex({ expires_at: 1 }, { expireAfterSeconds: 60 * 60 * 24 }),
  ]);
  await codes.updateMany(
    { subject_user_id: user._id, consumed_at: null, invalidated_at: null },
    {
      $set: {
        invalidated_at: now,
        invalidation_reason: "new_code_issued",
        telegram_status_retry_required: true,
      },
    },
  );
  const inserted = await codes.insertOne({
    code_hash: hashActionToken(rawCode),
    subject_user_id: user._id,
    subject_username: user.username || null,
    subject_email: user.email,
    reason: input.reason,
    created_by_telegram_id: input.actorTelegramId,
    created_at: now,
    expires_at: expiresAt,
    consumed_at: null,
    invalidated_at: null,
  });
  return { rawCode, expiresAt, insertedId: inserted.insertedId };
}
