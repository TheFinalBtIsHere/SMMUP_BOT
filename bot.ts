import { Telegraf } from "telegraf";
import { BOT_TOKEN, validateStartupConfig } from "./src/config.js";
import { closeDatabase, getDatabase } from "./src/db/client.js";
import { ensureAdminControlIndexes } from "./src/db/indexes.js";
import { registerOwnerAuthorization } from "./src/middleware/ownerAuthorization.js";
import { registerAdminDashboard } from "./src/commands/dashboard.js";
import { registerAdminActionCallbacks } from "./src/callbacks/adminActions.js";
import { registerGeneralCommands } from "./src/commands/general.js";
import { registerUserCommands } from "./src/commands/users.js";
import { registerRecoveryCommands } from "./src/commands/recovery.js";
import { registerOperationCommands } from "./src/commands/operations.js";
import { createWorkerRuntime } from "./src/worker/runtime.js";

export { ensureAdminControlIndexes } from "./src/db/indexes.js";
export { executeConfirmedAdminAction } from "./src/domain/adminActions.js";
export { settleImapPendingPayment } from "./src/worker/settlement.js";

validateStartupConfig();

const bot = new Telegraf(BOT_TOKEN);
registerOwnerAuthorization(bot);
registerAdminDashboard(bot);
registerAdminActionCallbacks(bot);
registerGeneralCommands(bot);
registerUserCommands(bot);
registerRecoveryCommands(bot);
registerOperationCommands(bot);
const workerRuntime = createWorkerRuntime(bot);

async function main() {
  try {
    const database = await getDatabase();
    await ensureAdminControlIndexes(database);
    const identity = await bot.telegram.getMe();
    await bot.telegram.setMyCommands([
      { command: "start", description: "Open the owner dashboard" },
      { command: "menu", description: "Open the owner dashboard" },
      { command: "help", description: "Show dashboard and command reference" },
      { command: "stats", description: "Platform metrics" },
      { command: "user", description: "Find a user by email" },
      { command: "userorders", description: "Show a user's recent orders" },
      { command: "deposits", description: "Show a user's transactions" },
      { command: "wallet", description: "Show a user's wallet ledger" },
      { command: "events", description: "Show a user's security events" },
      { command: "orders", description: "Show recent orders" },
      { command: "failed", description: "Show orders requiring review" },
      { command: "pending", description: "Show pending deposits" },
      { command: "checkmemo", description: "Look up a Direct UPI memo" },
      { command: "settleupi", description: "Stage trusted receipt reconciliation" },
      { command: "reviews", description: "Moderate buyer reviews" },
      { command: "credit", description: "Stage a wallet credit" },
      { command: "debit", description: "Stage a wallet debit" },
      { command: "refund", description: "Stage a reviewed order refund" },
      { command: "lock", description: "Lock a user account" },
      { command: "unlock", description: "Unlock a user account" },
      { command: "orderhold", description: "Hold user ordering" },
      { command: "orderrelease", description: "Release ordering hold" },
      { command: "paymenthold", description: "Hold user payments" },
      { command: "paymentrelease", description: "Release payment hold" },
      { command: "keypause", description: "Pause an API key" },
      { command: "keyresume", description: "Resume an API key" },
      { command: "keyarchive", description: "Archive an API key" },
      { command: "keyreissue", description: "Require secure API-key reissue" },
      { command: "note", description: "Add an audited owner note" },
      { command: "resetpassword", description: "Stage a temporary-password reset" },
      { command: "supportaccess", description: "Issue read-only Support Access" },
      { command: "scan", description: "Run a manual settlement scan" },
      { command: "cancel", description: "Cancel the current dashboard form" },
    ]).catch((error: any) => console.warn("[AdminBot] Telegram command menu sync skipped:", error?.name || "Error"));

    await bot.launch({
      allowedUpdates: ["message", "callback_query"],
      dropPendingUpdates: true,
    });
    console.log(`🚀 SMM UP Sovereign Admin Bot @${identity.username} launched via Telegram Bot API long polling.`);

    workerRuntime.startBackgroundWorker();
    workerRuntime.startTemporaryPasswordStatusWorker();

    process.once("SIGINT", () => {
      bot.stop("SIGINT");
      void closeDatabase();
      process.exit(0);
    });
    process.once("SIGTERM", () => {
      bot.stop("SIGTERM");
      void closeDatabase();
      process.exit(0);
    });
  } catch (err: any) {
    console.error("FATAL: Failed to start Admin Bot:", err.message);
    process.exit(1);
  }
}

if (process.env.ADMIN_BOT_DISABLE_AUTOSTART !== "true") {
  void main();
}
