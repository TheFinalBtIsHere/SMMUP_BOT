import crypto from "crypto";
import type { Db } from "mongodb";
import type { Telegraf } from "telegraf";
import { OWNER_ID } from "../config.js";
import { getDatabase } from "../db/client.js";
import { escapeHtml } from "../security/telegramHtml.js";

export function createPaymentWorkerRuntime(
  bot: Telegraf<any>,
  scanAndSettlePayments: () => Promise<string>,
) {
  // Background scheduler for Railway (executes every 20 seconds cleanly)
  let workerActive = false;
  const workerInstanceId = `railway_${process.pid}_${crypto.randomBytes(6).toString("hex")}`;

  async function acquireWorkerLease(database: Db): Promise<boolean> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + 180_000);
    const updated = await database.collection<any>("worker_leases").findOneAndUpdate(
      { _id: "imap_settlement", $or: [{ lease_until: { $lte: now } }, { holder: workerInstanceId }] },
      { $set: { holder: workerInstanceId, lease_until: leaseUntil, heartbeat_at: now } },
      { returnDocument: "after" },
    );
    if (updated?.holder === workerInstanceId) return true;
    try {
      await database.collection<any>("worker_leases").insertOne({
        _id: "imap_settlement", holder: workerInstanceId, lease_until: leaseUntil,
        heartbeat_at: now, created_at: now,
      } as any);
      return true;
    } catch (error: any) {
      if (error?.code === 11000) return false;
      throw error;
    }
  }

  async function reconcilePaymentOperations(database: Db) {
    const now = new Date();
    await database.collection("transactions").updateMany(
      { method: "FAMPAY_UPI", status: "pending", expires_at: { $lte: now } },
      { $set: { status: "expired", expired_at: now } },
    );
    for (let index = 0; index < 10; index += 1) {
      const claimId = crypto.randomBytes(12).toString("hex");
      const issue: any = await database.collection("payment_reconciliation").findOneAndUpdate(
        {
          status: "open",
          attempts: { $gte: 3 },
          owner_alerted_at: { $exists: false },
          $or: [
            { owner_alert_claimed_at: { $exists: false } },
            { owner_alert_claimed_at: { $lt: new Date(Date.now() - 2 * 60_000) } },
          ],
        },
        { $set: { owner_alert_claim_id: claimId, owner_alert_claimed_at: new Date() } },
        { sort: { created_at: 1 }, returnDocument: "after" },
      );
      if (!issue) break;
      try {
        await bot.telegram.sendMessage(
          OWNER_ID,
          `🚨 <b>Payment reconciliation retry limit reached</b>\nMemo: <code>${escapeHtml(issue.memo || "unknown")}</code>\nReason: <code>${escapeHtml(issue.reason || "unknown")}</code>\nAttempts: <b>${Number(issue.attempts || 0)}</b>`,
          { parse_mode: "HTML" },
        );
        await database.collection("payment_reconciliation").updateOne(
          { _id: issue._id, owner_alert_claim_id: claimId, owner_alerted_at: { $exists: false } },
          {
            $set: { owner_alerted_at: new Date() },
            $unset: { owner_alert_claim_id: "", owner_alert_claimed_at: "" },
          },
        );
      } catch (error) {
        await database.collection("payment_reconciliation").updateOne(
          { _id: issue._id, owner_alert_claim_id: claimId, owner_alerted_at: { $exists: false } },
          { $unset: { owner_alert_claim_id: "", owner_alert_claimed_at: "" } },
        );
        throw error;
      }
    }
  }

  async function recordWorkerHealth(database: Db, ok: boolean, detail?: string) {
    const now = new Date();
    if (ok) {
      await database.collection<any>("system_health").updateOne(
        { _id: "imap_settlement_worker" },
        {
          $set: {
            status: "healthy", holder: workerInstanceId, heartbeat_at: now,
            last_success_at: now, consecutive_errors: 0,
          },
          $setOnInsert: { created_at: now },
          $unset: { last_error: "" },
        },
        { upsert: true },
      );
      return;
    }
    const health: any = await database.collection<any>("system_health").findOneAndUpdate(
      { _id: "imap_settlement_worker" },
      {
        $set: {
          status: "error", holder: workerInstanceId, heartbeat_at: now,
          last_error_at: now, last_error: String(detail || "unknown").slice(0, 500),
        },
        $inc: { consecutive_errors: 1 },
        $setOnInsert: { created_at: now },
      },
      { upsert: true, returnDocument: "after" },
    );
    const failures = Number(health?.consecutive_errors || 1);
    if (OWNER_ID && (failures === 3 || failures % 10 === 0)) {
      await bot.telegram.sendMessage(
        OWNER_ID,
        `🚨 <b>IMAP settlement worker unhealthy</b>\nConsecutive failures: <b>${failures}</b>\nError: <code>details omitted; check Railway logs</code>`,
        { parse_mode: "HTML" },
      ).catch(console.error);
    }
  }

  function startBackgroundWorker() {
    const isEnabled = process.env.ENABLE_IMAP_WORKER !== "false";
    if (!isEnabled) {
      console.log("[Worker] Background IMAP worker is disabled via ENABLE_IMAP_WORKER=false.");
      return;
    }

    console.log("[Worker] Starting Railway background IMAP settlement worker (interval: 20s)...");

    setInterval(async () => {
      if (workerActive) return;
      workerActive = true;
      try {
        const database = await getDatabase();
        if (!await acquireWorkerLease(database)) return;
        await scanAndSettlePayments();
        await reconcilePaymentOperations(database);
        await recordWorkerHealth(database, true);
      } catch (err: any) {
        console.error("[Worker Error]", err.message);
        const database = await getDatabase().catch(() => null);
        if (database) await recordWorkerHealth(database, false, err.message).catch(() => {});
      } finally {
        workerActive = false;
      }
    }, 20000);
  }


  async function runManualScan(ctx: any) {
    const dashboardKeyboard = { inline_keyboard: [[
      { text: "⚙️ Worker health", callback_data: "d:workers" },
      { text: "🏠 Dashboard", callback_data: "d:home" },
    ]] };
    if (workerActive) return ctx.reply("ℹ️ A settlement scan is already active on this instance.", { reply_markup: dashboardKeyboard });
    workerActive = true;
    try {
      await ctx.reply("📡 Running manual IMAP settlement scan...");
      const database = await getDatabase();
      if (!await acquireWorkerLease(database)) {
        return ctx.reply("ℹ️ Another Railway instance currently owns the settlement lease.", { reply_markup: dashboardKeyboard });
      }
      const result = await scanAndSettlePayments();
      await reconcilePaymentOperations(database);
      await recordWorkerHealth(database, true);
      await ctx.reply(result, { reply_markup: dashboardKeyboard });
    } catch (err: any) {
      const database = await getDatabase().catch(() => null);
      if (database) await recordWorkerHealth(database, false, err.message).catch(() => {});
      console.error("[Worker Error] Manual IMAP scan failed:", err?.name || "Error");
      await ctx.reply("❌ IMAP scan failed. Internal details were withheld; check worker health and Railway logs.", {
        reply_markup: dashboardKeyboard,
      });
    } finally {
      workerActive = false;
    }
  }

  // Command and dashboard button share the same guarded manual-scan path.
  bot.command("scan", runManualScan);
  bot.action("worker:scan", async (ctx) => {
    await ctx.answerCbQuery("Manual scan requested.").catch(() => {});
    await runManualScan(ctx);
  });

  return { startBackgroundWorker };
}
