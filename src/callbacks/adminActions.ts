import type { Telegraf } from "telegraf";
import { getDatabase, getMongoClient } from "../db/client.js";
import { executeConfirmedAdminAction } from "../domain/adminActions.js";
import { hashActionToken } from "../security/adminState.js";

export function registerAdminActionCallbacks(bot: Telegraf<any>) {
  bot.action(/^adm-no:([A-Za-z0-9_-]{24})$/, async (ctx) => {
    try {
      const database = await getDatabase();
      const result = await database.collection("admin_pending_actions").updateOne(
        {
          token_hash: hashActionToken(ctx.match[1]),
          actor_telegram_id: String(ctx.from?.id || ""),
          status: "pending",
          expires_at: { $gt: new Date() },
        },
        { $set: { status: "cancelled", cancelled_at: new Date() } },
      );
      await ctx.answerCbQuery(result.modifiedCount ? "Action cancelled." : "Action already expired or consumed.");
      await ctx.editMessageText(result.modifiedCount ? "Cancelled. No change was made." : "This action is no longer available.");
    } catch (error: any) {
      await ctx.answerCbQuery(`Cancel failed: ${String(error.message).slice(0, 100)}`, { show_alert: true });
    }
  });

  bot.action(/^adm-ok:([A-Za-z0-9_-]{24})$/, async (ctx) => {
    const database = await getDatabase();
    const mongoClient = getMongoClient();
    if (!mongoClient) return ctx.answerCbQuery("Database unavailable.", { show_alert: true });
    const mongoSession = mongoClient.startSession();
    let resultText = "";
    try {
      await mongoSession.withTransaction(async () => {
        const now = new Date();
        const action: any = await database.collection("admin_pending_actions").findOneAndUpdate(
          {
            token_hash: hashActionToken(ctx.match[1]),
            actor_telegram_id: String(ctx.from?.id || ""),
            status: "pending",
            expires_at: { $gt: now },
          },
          { $set: { status: "executing", consumed_at: now } },
          { returnDocument: "after", session: mongoSession },
        );
        if (!action) throw new Error("ACTION_EXPIRED_OR_USED");
        resultText = await executeConfirmedAdminAction(database, action, mongoSession);
        await database.collection("admin_pending_actions").updateOne(
          { _id: action._id, status: "executing" },
          { $set: { status: "completed", completed_at: new Date() } },
          { session: mongoSession },
        );
      });
      await ctx.answerCbQuery("Action completed.");
      await ctx.editMessageText(resultText, { parse_mode: "HTML" });
    } catch (error: any) {
      const messages: Record<string, string> = {
        ACTION_EXPIRED_OR_USED: "This confirmation expired or was already used.",
        USER_NOT_FOUND: "The user no longer exists.",
        INSUFFICIENT_BALANCE: "The user no longer has enough balance.",
        BALANCE_CHANGED: "The balance changed. Build a new confirmation.",
        ORDER_NOT_FOUND: "The order no longer exists.",
        ALREADY_REFUNDED: "The order was already refunded.",
        INVALID_REFUND_AMOUNT: "The order has no refundable amount.",
        PENDING_DEPOSIT_STALE: "The Direct UPI request is no longer eligible or was already settled.",
        RECEIPT_AMOUNT_MISMATCH: "The receipt amount no longer matches the stored Direct UPI request.",
        PAYMENT_HOLD_ACTIVE: "This account has an active payment hold; no credit was committed.",
        INVALID_REASON: "The reconciliation reason is missing or invalid.",
        API_KEY_NOT_FOUND: "The API key no longer exists.",
        API_REISSUE_PENDING: "The user must securely rotate this key on the website before it can resume.",
      };
      const message = messages[error?.message] || "Action failed safely; no partial mutation was committed.";
      console.error("[AdminBot] Confirmed action failed:", error);
      await ctx.answerCbQuery(message, { show_alert: true });
    } finally {
      await mongoSession.endSession();
    }
  });
}
