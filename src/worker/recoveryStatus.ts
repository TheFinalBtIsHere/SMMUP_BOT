import type { Telegraf } from "telegraf";
import { OWNER_ID } from "../config.js";
import { getDatabase } from "../db/client.js";
import { escapeHtml } from "../security/telegramHtml.js";

export function createRecoveryStatusWorker(bot: Telegraf<any>) {
  async function syncPendingTemporaryPasswordMessages() {
    const database = await getDatabase();
    const now = new Date();

    for (let index = 0; index < 10; index += 1) {
      const staleOrder: any = await database.collection("orders").findOneAndUpdate(
        {
          status: "Submitting",
          created_at: { $lte: new Date(now.getTime() - 5 * 60_000) },
        },
        {
          $set: {
            status: "Submission uncertain",
            refund_status: "requires_admin_review",
            provider_error: "Submission did not reach a locally confirmed state before the safety deadline.",
            updated_at: now,
          },
        },
        { sort: { created_at: 1 }, returnDocument: "after" },
      );
      if (!staleOrder) break;
      await bot.telegram.sendMessage(
        OWNER_ID,
        `🚨 <b>Stale order submission requires review</b>\nOrder: <code>${staleOrder._id.toString()}</code>\nUser: <code>${escapeHtml(staleOrder.user_email || "unknown")}</code>\nService: ${escapeHtml(staleOrder.service_name || staleOrder.service_id)}\nCharge held: <b>₹${Number(staleOrder.charge || 0).toFixed(2)}</b>\n<i>Do not blindly resubmit or auto-refund; reconcile supplier records first.</i>`,
        { parse_mode: "HTML" },
      ).catch((error) => console.error("[AdminBot] Stale-order alert failed:", error));
    }

    const records: any[] = await database.collection("temporary_passwords").find({
      telegram_chat_id: { $exists: true },
      telegram_message_id: { $exists: true },
      $or: [
        { telegram_status_retry_required: true },
        { status: "active", expires_at: { $lte: now } },
      ],
    }).sort({ created_at: 1 }).limit(20).toArray();

    for (const temporary of records) {
      const usedCount = Number(temporary.used_count || 0);
      const maxUses = Number(temporary.max_uses || 1);
      const expired = temporary.status === "active" && new Date(temporary.expires_at) <= now;
      const state = expired ? "expired" : temporary.telegram_status_state || temporary.status;
      if (expired) {
        await database.collection("temporary_passwords").updateOne(
          { _id: temporary._id, status: "active" },
          { $set: { status: "expired", invalidated_at: now, invalidation_reason: "expired" } },
        );
      }
      const remaining = Math.max(0, maxUses - usedCount);
      const statusLine = state === "completed"
        ? "✅ Permanent password created · Temporary credential invalidated"
        : state === "expired"
          ? `⌛ Expired after ${usedCount}/${maxUses} uses`
          : `✅ Used ${usedCount}/${maxUses} · ${remaining} use${remaining === 1 ? "" : "s"} remaining`;
      const text = [
        "🔐 <b>Temporary Password Reset</b>",
        "",
        `User: <code>@${escapeHtml(temporary.username)}</code>`,
        `Email: <code>${escapeHtml(temporary.user_email)}</code>`,
        "Temporary password: <i>hidden after initial creation</i>",
        `Expires: <code>${new Date(temporary.expires_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</code>`,
        `Uses: <code>${usedCount}/${maxUses}</code>`,
        `Status: ${statusLine}`,
        `Reason: ${escapeHtml(temporary.reason || "Owner recovery")}`,
      ].join("\n");
      try {
        await bot.telegram.editMessageText(
          temporary.telegram_chat_id,
          temporary.telegram_message_id,
          undefined,
          text,
          { parse_mode: "HTML" },
        );
        await database.collection("temporary_passwords").updateOne(
          { _id: temporary._id },
          {
            $set: { telegram_status_synced: true, telegram_status_updated_at: new Date() },
            $unset: { telegram_status_retry_required: "" },
          },
        );
      } catch (error: any) {
        console.error("[AdminBot] Temporary-password status sync failed:", error?.message || error);
      }
    }

    const supportRecords: any[] = await database.collection("support_access_codes").find({
      telegram_chat_id: { $exists: true },
      telegram_message_id: { $exists: true },
      $or: [
        { telegram_status_retry_required: true },
        { consumed_at: null, invalidated_at: null, expires_at: { $lte: now } },
        { consumed_at: { $ne: null }, support_session_status: "active", support_session_expires_at: { $lte: now } },
      ],
    }).sort({ created_at: 1 }).limit(20).toArray();
    for (const access of supportRecords) {
      const consumed = Boolean(access.consumed_at);
      const sessionExpired = consumed && access.support_session_status === "active" && new Date(access.support_session_expires_at) <= now;
      const status = access.support_session_status === "exited"
        ? "✅ Session exited"
        : access.support_session_status === "revoked"
          ? "🚫 Session revoked by owner"
          : sessionExpired
          ? "⌛ Website support session expired"
          : consumed
            ? "✅ Exchanged · session active"
            : access.invalidation_reason === "new_code_issued"
              ? "♻️ Replaced by a newer code"
              : access.invalidation_reason === "telegram_delivery_failed"
                ? "❌ Invalidated after delivery failure"
                : "⌛ Expired unused";
      const text = [
        "👁 <b>Support Access</b>",
        "",
        `User: <code>@${escapeHtml(access.subject_username)}</code>`,
        `Email: <code>${escapeHtml(access.subject_email)}</code>`,
        "Code: <i>consumed or hidden</i>",
        `Status: ${status}`,
        `Permissions: <b>Read-only</b>`,
        `Reason: ${escapeHtml(access.reason || "Owner support")}`,
      ].join("\n");
      try {
        await bot.telegram.editMessageText(
          access.telegram_chat_id,
          access.telegram_message_id,
          undefined,
          text,
          { parse_mode: "HTML" },
        );
        await database.collection("support_access_codes").updateOne(
          { _id: access._id },
          {
            $set: {
              ...(consumed || access.invalidated_at ? {} : {
                invalidated_at: now,
                invalidation_reason: "expired",
              }),
              ...(sessionExpired ? {
                support_session_status: "expired",
                support_session_ended_at: now,
              } : {}),
              telegram_status_synced: true,
              telegram_status_updated_at: now,
            },
            $unset: { telegram_status_retry_required: "" },
          },
        );
      } catch (error: any) {
        console.error("[AdminBot] Support Access status sync failed:", error?.message || error);
      }
    }
  }

  function startTemporaryPasswordStatusWorker() {
    syncPendingTemporaryPasswordMessages().catch((error) => console.error("[Recovery Worker]", error));
    setInterval(() => {
      syncPendingTemporaryPasswordMessages().catch((error) => console.error("[Recovery Worker]", error));
    }, 60_000);
  }

  return { startTemporaryPasswordStatusWorker };
}
