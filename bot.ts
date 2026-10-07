import { Telegraf } from "telegraf";
import { BOT_TOKEN, validateStartupConfig } from "./src/config.js";
import { closeDatabase, getDatabase } from "./src/db/client.js";
import { ensureAdminControlIndexes } from "./src/db/indexes.js";
import { registerOwnerAuthorization } from "./src/middleware/ownerAuthorization.js";
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
