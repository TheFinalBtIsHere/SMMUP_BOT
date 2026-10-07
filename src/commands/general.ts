import { ObjectId } from "mongodb";
import type { Telegraf } from "telegraf";
import { getDatabase } from "../db/client.js";
import { escapeHtml } from "../security/telegramHtml.js";
import { reviewModerationKeyboard, reviewModerationText } from "../ui/reviews.js";

export function registerGeneralCommands(bot: Telegraf<any>) {
  // /stats
  bot.command("stats", async (ctx) => {
    try {
      const database = await getDatabase();
      const usersCount = await database.collection("users").countDocuments();
      const ordersCount = await database.collection("orders").countDocuments();
      const transactionsCount = await database.collection("transactions").countDocuments({ status: "paid" });

      // Calculate aggregated balances
      const balanceAgg = await database.collection("users").aggregate([
        {
          $group: {
            _id: null,
            totalBalance: { $sum: "$balance" },
            totalSpent: { $sum: "$total_spent" },
          },
        },
      ]).toArray();

      const totalBalance = Number(balanceAgg[0]?.totalBalance || 0);
      const totalSpent = Number(balanceAgg[0]?.totalSpent || 0);

      const statsMsg = `
  📊 <b>SMM UP Live Platform Telemetry</b>

  👥 <b>Total Registered Users:</b> <code>${usersCount.toLocaleString()}</code>
  💳 <b>Total User Balances:</b> <code>₹${totalBalance.toFixed(2)}</code>
  📦 <b>Total Orders Executed:</b> <code>${ordersCount.toLocaleString()}</code>
  💸 <b>Total Volume Spent:</b> <code>₹${totalSpent.toFixed(2)}</code>
  ✅ <b>Settled Deposits:</b> <code>${transactionsCount.toLocaleString()}</code>

  <i>Telemetry synchronized from MongoDB Atlas</i>
  `;
      await ctx.reply(statsMsg, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[
          { text: "🔄 Refresh overview", callback_data: "d:overview" },
          { text: "🏠 Dashboard", callback_data: "d:home" },
        ]] },
      });
    } catch (err: any) {
      await ctx.reply(`❌ Error fetching stats: ${err.message}`);
    }
  });

  // /reviews [limit] — zero-web-surface review moderation
  bot.command("reviews", async (ctx) => {
    try {
      const requested = Number(ctx.message.text.trim().split(/\s+/)[1] || 8);
      const limit = Math.max(1, Math.min(Number.isFinite(requested) ? Math.trunc(requested) : 8, 12));
      const database = await getDatabase();
      const reviews = await database
        .collection("reviews")
        .find({ seed: { $ne: true } })
        .sort({ created_at: -1 })
        .limit(limit)
        .toArray();

      if (!reviews.length) {
        return ctx.reply("⭐ No buyer-submitted reviews yet. The six permanent homepage reviews are unchanged.");
      }

      await ctx.reply(
        `⭐ <b>Latest ${reviews.length} Buyer Review${reviews.length === 1 ? "" : "s"}</b>\n` +
        `<i>Tap the button under any review to hide or restore it instantly.</i>`,
        { parse_mode: "HTML" }
      );

      for (const r of reviews) {
        const status: "approved" | "hidden" = r.status === "hidden" ? "hidden" : "approved";
        await ctx.reply(reviewModerationText(r, status), {
          parse_mode: "HTML",
          reply_markup: reviewModerationKeyboard(r._id, status),
        });
      }
    } catch (err: any) {
      await ctx.reply(`❌ Review moderation failed: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
    }
  });

  bot.action(/^review-toggle:([a-f0-9]{24})$/, async (ctx) => {
    try {
      const database = await getDatabase();
      const id = new ObjectId(ctx.match[1]);
      const review = await database.collection("reviews").findOne({ _id: id, seed: { $ne: true } });
      if (!review) {
        await ctx.answerCbQuery("Review no longer exists.", { show_alert: true });
        return;
      }

      const nextStatus: "approved" | "hidden" = review.status === "hidden" ? "approved" : "hidden";
      const moderatedAt = new Date();
      await Promise.all([
        database.collection("reviews").updateOne(
          { _id: id },
          { $set: { status: nextStatus, moderated_at: moderatedAt, moderated_via: "telegram_bot" } },
        ),
        database.collection("admin_audit").insertOne({
          action_type: "review_moderation", actor_telegram_id: String(ctx.from?.id),
          outcome: "completed", details: { review_id: id, status: nextStatus }, created_at: moderatedAt,
        }),
      ]);

      await ctx.editMessageText(reviewModerationText(review, nextStatus), {
        parse_mode: "HTML",
        reply_markup: reviewModerationKeyboard(id, nextStatus),
      });
      await ctx.answerCbQuery(nextStatus === "hidden" ? "Review hidden from the site." : "Review restored on the site.");
    } catch (err: any) {
      await ctx.answerCbQuery(`Failed: ${String(err.message).slice(0, 120)}`, { show_alert: true });
    }
  });
}
