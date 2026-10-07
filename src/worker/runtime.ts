import type { Telegraf } from "telegraf";
import { createPaymentScanner } from "./paymentScanner.js";
import { createPaymentWorkerRuntime } from "./paymentRuntime.js";
import { createRecoveryStatusWorker } from "./recoveryStatus.js";

export function createWorkerRuntime(bot: Telegraf<any>) {
  const scanner = createPaymentScanner(bot);
  const paymentWorker = createPaymentWorkerRuntime(bot, scanner.scanAndSettlePayments);
  const recoveryStatusWorker = createRecoveryStatusWorker(bot);

  return {
    startBackgroundWorker: paymentWorker.startBackgroundWorker,
    startTemporaryPasswordStatusWorker: recoveryStatusWorker.startTemporaryPasswordStatusWorker,
  };
}
