import crypto from "crypto";
import { getDatabase } from "../db/client.js";
import { ensureAdminControlIndexes } from "../db/indexes.js";
import { hashActionToken } from "../security/adminState.js";

const ADMIN_ACTION_TTL_MS = 5 * 60_000;

export async function queueAdminAction(ctx: any, type: string, payload: Record<string, any>, summary: string) {
  const database = await getDatabase();
  await ensureAdminControlIndexes(database);
  const actorTelegramId = String(ctx.from?.id || "");
  const recent = await database.collection("admin_pending_actions").countDocuments({
    actor_telegram_id: actorTelegramId,
    created_at: { $gt: new Date(Date.now() - ADMIN_ACTION_TTL_MS) },
  });
  if (recent >= 20) throw new Error("Too many pending administrative actions. Wait five minutes.");
  const raw = crypto.randomBytes(18).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ADMIN_ACTION_TTL_MS);
  await database.collection("admin_pending_actions").insertOne({
    token_hash: hashActionToken(raw),
    type,
    payload,
    summary,
    status: "pending",
    actor_telegram_id: actorTelegramId,
    actor_username: ctx.from?.username || null,
    chat_id: ctx.chat?.id || null,
    created_at: now,
    expires_at: expiresAt,
    consumed_at: null,
    cancelled_at: null,
  });
  try {
    await ctx.reply(
      `${summary}\n\n⏳ Confirm by <code>${expiresAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</code>.\n<i>The action is rebuilt from current database state when confirmed.</i>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Confirm", callback_data: `adm-ok:${raw}` },
              { text: "Cancel", callback_data: `adm-no:${raw}` },
            ],
            [{ text: "🏠 Dashboard", callback_data: "d:home" }],
          ],
        },
      },
    );
  } catch (error) {
    await database.collection("admin_pending_actions").updateOne(
      { token_hash: hashActionToken(raw), status: "pending" },
      { $set: { status: "delivery_failed", cancelled_at: new Date(), delivery_error_class: (error as any)?.name || "Error" } },
    ).catch(() => {});
    throw error;
  }
}

export function parseReasonedCommand(text: string, command: string) {
  const input = text.replace(new RegExp(`^\\/${command}(?:@\\w+)?\\s*`, "i"), "").trim();
  const separator = input.indexOf("|");
  if (separator < 0) return null;
  const left = input.slice(0, separator).trim().split(/\s+/);
  const reason = input.slice(separator + 1).trim();
  if (reason.length < 5 || reason.length > 500) return null;
  return { left, reason };
}
