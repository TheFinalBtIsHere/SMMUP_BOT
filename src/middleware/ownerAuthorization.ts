import type { Telegraf } from "telegraf";
import { OWNER_ID } from "../config.js";

export function registerOwnerAuthorization(bot: Telegraf<any>) {
  bot.use(async (ctx, next) => {
    const senderId = ctx.from?.id?.toString();
    if (!senderId || senderId !== OWNER_ID.trim()) {
      console.warn(`[SECURITY] Rejected unauthorized interaction from ID: ${senderId} (@${ctx.from?.username || "unknown"})`);
      await ctx.reply("⛔ <b>Unauthorized Access.</b>\nThis bot is strictly private and restricted to the platform owner.", {
        parse_mode: "HTML",
      });
      return;
    }
    return next();
  });
}
