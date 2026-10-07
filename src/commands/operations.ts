import { ObjectId } from "mongodb";
import type { Telegraf } from "telegraf";
import { getDatabase } from "../db/client.js";
import { parseReasonedCommand, queueAdminAction } from "../domain/pendingActions.js";
import { escapeHtml } from "../security/telegramHtml.js";

export function registerOperationCommands(bot: Telegraf<any>) {
  // /credit <email> <amount> | <mandatory reason>
  bot.command("credit", async (ctx) => {
    try {
      const parsed = parseReasonedCommand(ctx.message.text, "credit");
      if (!parsed || parsed.left.length !== 2) {
        return ctx.reply("⚠️ Usage: <code>/credit user@example.com 250 | exact correction reason</code>", { parse_mode: "HTML" });
      }
      const [emailRaw, amountRaw] = parsed.left;
      const email = emailRaw.toLowerCase();
      const amountPaise = Math.round(Number(amountRaw) * 100);
      if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0 || amountPaise > 100_000_000_00) {
        return ctx.reply("❌ Enter a valid positive amount within the administrative bound.");
      }
      const database = await getDatabase();
      const user: any = await database.collection("users").findOne({ email });
      if (!user) return ctx.reply("❌ User not found.");
      await queueAdminAction(ctx, "wallet_credit", {
        user_id: user._id.toString(), amount_paise: amountPaise, reason: parsed.reason,
      }, `💰 <b>Confirm wallet credit</b>\nUser: <code>${escapeHtml(user.email)}</code>\nAmount: <b>₹${(amountPaise / 100).toFixed(2)}</b>\nCurrent balance: <code>₹${Number(user.balance || 0).toFixed(2)}</code>\nReason: ${escapeHtml(parsed.reason)}`);
    } catch (error: any) {
      await ctx.reply(`❌ ${escapeHtml(error.message)}`, { parse_mode: "HTML" });
    }
  });

  // /debit <email> <amount> | <mandatory reason>
  bot.command("debit", async (ctx) => {
    try {
      const parsed = parseReasonedCommand(ctx.message.text, "debit");
      if (!parsed || parsed.left.length !== 2) {
        return ctx.reply("⚠️ Usage: <code>/debit user@example.com 250 | exact correction reason</code>", { parse_mode: "HTML" });
      }
      const [emailRaw, amountRaw] = parsed.left;
      const email = emailRaw.toLowerCase();
      const amountPaise = Math.round(Number(amountRaw) * 100);
      if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0 || amountPaise > 100_000_000_00) {
        return ctx.reply("❌ Enter a valid positive amount within the administrative bound.");
      }
      const database = await getDatabase();
      const user: any = await database.collection("users").findOne({ email });
      if (!user) return ctx.reply("❌ User not found.");
      await queueAdminAction(ctx, "wallet_debit", {
        user_id: user._id.toString(), amount_paise: amountPaise, reason: parsed.reason,
      }, `🔻 <b>Confirm wallet debit</b>\nUser: <code>${escapeHtml(user.email)}</code>\nAmount: <b>₹${(amountPaise / 100).toFixed(2)}</b>\nCurrent balance: <code>₹${Number(user.balance || 0).toFixed(2)}</code>\nReason: ${escapeHtml(parsed.reason)}`);
    } catch (error: any) {
      await ctx.reply(`❌ ${escapeHtml(error.message)}`, { parse_mode: "HTML" });
    }
  });

  // /settleupi <memo> <amount> <utr> <transactionId> | <mandatory reason>
  // Owner-only middleware is applied at bot startup. This is the safe recovery
  // path for legacy whole-rupee receipts where FamApp removed the SUP note.
  bot.command("settleupi", async (ctx) => {
    try {
      const parsed = parseReasonedCommand(ctx.message.text, "settleupi");
      if (!parsed || parsed.left.length !== 4) {
        return ctx.reply(
          "⚠️ Usage: <code>/settleupi SUPABCDE 50.00 987654321012 FMPIB1234567890 | exact reconciliation reason</code>",
          { parse_mode: "HTML" },
        );
      }
      const [memoRaw, amountRaw, utrRaw, transactionIdRaw] = parsed.left;
      const memo = memoRaw.trim().toUpperCase();
      const utr = utrRaw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      const transactionId = transactionIdRaw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(amountRaw)) throw new Error("Enter the exact positive receipt amount with at most two decimal places.");
      const amountPaise = Math.round(Number(amountRaw) * 100);
      if (!/^SUP[A-Z0-9]{5}$/.test(memo)) throw new Error("Enter the exact SUP reference from the pending request.");
      if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new Error("Enter the exact positive receipt amount.");
      if (!/^\d{12}$/.test(utr)) throw new Error("Enter the exact 12-digit UTR.");
      if (!/^[A-Z0-9]{8,40}$/.test(transactionId)) throw new Error("Enter the exact FamApp transaction ID.");

      const database = await getDatabase();
      const pending: any = await database.collection("transactions").findOne({
        memo,
        method: "FAMPAY_UPI",
        status: { $in: ["pending", "expired"] },
      });
      if (!pending) throw new Error("No eligible pending/expired Direct UPI request has this SUP reference.");
      if (Math.round(Number(pending.amount) * 100) !== amountPaise) throw new Error("Receipt amount does not match the stored pending request.");

      await queueAdminAction(ctx, "direct_upi_reconcile", {
        pending_id: pending._id.toString(),
        user_id: pending.user_id.toString(),
        amount_paise: amountPaise,
        memo,
        utr,
        transaction_id: transactionId,
        reason: parsed.reason,
      }, [
        "🧾 <b>Confirm Direct UPI reconciliation</b>",
        `User: <code>${escapeHtml(pending.user_email || "unknown")}</code>`,
        `Amount: <b>₹${(amountPaise / 100).toFixed(2)}</b>`,
        `Memo: <code>${escapeHtml(memo)}</code>`,
        `UTR: <code>${escapeHtml(utr)}</code>`,
        `TxID: <code>${escapeHtml(transactionId)}</code>`,
        `Reason: ${escapeHtml(parsed.reason)}`,
        "<i>Use only after visually confirming the trusted incoming FamApp receipt.</i>",
      ].join("\n"));
    } catch (error: any) {
      await ctx.reply(`❌ ${escapeHtml(error.message)}`, { parse_mode: "HTML" });
    }
  });

  // /pending
  bot.command("pending", async (ctx) => {
    try {
      const database = await getDatabase();
      const pendingList = await database
        .collection("transactions")
        .find({ status: "pending" })
        .sort({ created_at: -1 })
        .limit(10)
        .toArray();

      if (pendingList.length === 0) {
        return ctx.reply("✨ No pending deposits currently awaiting settlement.");
      }

      let msg = `⏳ <b>Pending Deposit Requests (${pendingList.length}):</b>\n\n`;
      for (const item of pendingList) {
        const minutesAgo = Math.round((Date.now() - new Date(item.created_at).getTime()) / 60000);
        const memo = escapeHtml(item.memo || "NO_MEMO");
        msg += `• <b>₹${Number(item.amount || 0).toFixed(2)}</b> | <code>${memo}</code>\n`;
        msg += `  User: <code>${escapeHtml(item.user_email || "unknown")}</code> (${minutesAgo}m ago)\n`;
        msg += `  Inspect: <code>/checkmemo ${memo}</code>\n\n`;
      }

      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch (err: any) {
      await ctx.reply(`❌ Error fetching pending: ${err.message}`);
    }
  });

  // /orders [limit]
  bot.command("orders", async (ctx) => {
    try {
      const parts = ctx.message.text.trim().split(/\s+/);
      const requestedLimit = Number.parseInt(parts[1] || "5", 10);
      const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 20)) : 5;

      const database = await getDatabase();
      const orders = await database
        .collection("orders")
        .find({})
        .sort({ created_at: -1 })
        .limit(limit)
        .toArray();

      if (orders.length === 0) {
        return ctx.reply("No orders recorded yet.");
      }

      let msg = `📦 <b>Recent ${orders.length} Orders:</b>\n\n`;
      for (const ord of orders) {
        msg += `• #${escapeHtml(ord.provider_order_id || ord._id.toString().slice(-6))}: <b>${escapeHtml(ord.status || "unknown")}</b>\n`;
        msg += `  Service: ${escapeHtml(ord.service_name || ord.service_id)}\n`;
        msg += `  User: <code>${escapeHtml(ord.user_email || "unknown")}</code> | Charge: ₹${Number(ord.charge || 0).toFixed(2)}\n`;
        msg += `  Link: <code>${escapeHtml(ord.link || "—")}</code>\n\n`;
      }

      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch (err: any) {
      await ctx.reply(`❌ Error fetching orders: ${err.message}`);
    }
  });

  // /failed
  bot.command("failed", async (ctx) => {
    try {
      const database = await getDatabase();
      const failedOrders = await database
        .collection("orders")
        .find({
          $or: [
            { refund_status: "requires_admin_review" },
            { status: "Failed" },
          ],
        })
        .sort({ created_at: -1 })
        .limit(10)
        .toArray();

      if (failedOrders.length === 0) {
        return ctx.reply("✨ No failed orders currently requiring admin review!");
      }

      let msg = `🚨 <b>Failed Orders Requiring Manual Review (${failedOrders.length}):</b>\n\n`;
      for (const ord of failedOrders) {
        const isRefunded = ord.refund_status === "refunded";
        const id = ord._id.toString();
        msg += `• <b>ID:</b> <code>${id}</code>\n`;
        msg += `  👤 User: <code>${escapeHtml(ord.user_email || "unknown")}</code>\n`;
        msg += `  📦 Service: ${escapeHtml(ord.service_name || ord.service_id)}\n`;
        msg += `  💵 Charge: <b>₹${Number(ord.charge || 0).toFixed(2)}</b>\n`;
        msg += `  ⚠️ Reason: <i>${escapeHtml(ord.provider_error || "Unknown")}</i>\n`;
        msg += `  🚦 Status: <b>${escapeHtml(ord.status || "unknown")}</b> (${escapeHtml(ord.refund_status || "held")})\n`;
        if (!isRefunded) {
          msg += `  ↩️ <b>Reviewed Refund:</b> <code>/refund ${id} | exact reviewed reason</code>\n\n`;
        } else {
          msg += `  ✅ <i>Already refunded manually</i>\n\n`;
        }
      }

      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch (err: any) {
      await ctx.reply(`❌ Error fetching failed orders: ${err.message}`);
    }
  });

  // /refund <orderId> | <mandatory reason>
  bot.command("refund", async (ctx) => {
    try {
      const parsed = parseReasonedCommand(ctx.message.text, "refund");
      if (!parsed || parsed.left.length !== 1 || !ObjectId.isValid(parsed.left[0])) {
        return ctx.reply("⚠️ Usage: <code>/refund &lt;orderId&gt; | exact reviewed reason</code>", { parse_mode: "HTML" });
      }
      const database = await getDatabase();
      const order: any = await database.collection("orders").findOne({ _id: new ObjectId(parsed.left[0]) });
      if (!order) return ctx.reply("❌ Order not found.");
      if (order.refund_status === "refunded") return ctx.reply("⚠️ This order is already refunded.");
      await queueAdminAction(ctx, "order_refund", {
        order_id: order._id.toString(), reason: parsed.reason,
      }, `↩️ <b>Confirm atomic order refund</b>\nOrder: <code>${order._id.toString()}</code>\nUser: <code>${escapeHtml(order.user_email)}</code>\nAmount: <b>₹${Number(order.charge || 0).toFixed(2)}</b>\nService: ${escapeHtml(order.service_name || order.service_id)}\nReason: ${escapeHtml(parsed.reason)}`);
    } catch (error: any) {
      await ctx.reply(`❌ ${escapeHtml(error.message)}`, { parse_mode: "HTML" });
    }
  });

  // /checkmemo <memo>
  bot.command("checkmemo", async (ctx) => {
    try {
      const parts = ctx.message.text.trim().split(/\s+/);
      if (parts.length < 2) {
        return ctx.reply("⚠️ Usage: <code>/checkmemo &lt;memo&gt;</code>", { parse_mode: "HTML" });
      }

      const memo = parts[1].toUpperCase().trim();
      if (!/^SUP[A-Z0-9]{5}$/.test(memo)) {
        return ctx.reply("❌ Memo must use the exact SUP plus five-character format.");
      }
      const database = await getDatabase();
      const txn = await database.collection("transactions").findOne({ memo });

      if (!txn) {
        return ctx.reply(`❌ Memo <code>${memo}</code> not found in database.`, { parse_mode: "HTML" });
      }

      const msg = `
  📑 <b>Memo Details:</b> <code>${escapeHtml(memo)}</code>
  👤 <b>User:</b> <code>${escapeHtml(txn.user_email || "unknown")}</code>
  💰 <b>Amount:</b> <code>₹${Number(txn.amount || 0).toFixed(2)}</code>
  🚦 <b>Status:</b> <b>${escapeHtml(txn.status || "unknown")}</b>
  📅 <b>Created:</b> <code>${new Date(txn.created_at).toLocaleString("en-IN")}</code>
  ${txn.utr ? `🔗 <b>UTR:</b> <code>${escapeHtml(txn.utr)}</code>\n` : ""}${txn.transaction_id ? `💳 <b>TxID:</b> <code>${escapeHtml(txn.transaction_id)}</code>\n` : ""}
  `;
      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch (err: any) {
      await ctx.reply(`❌ Error checking memo: ${err.message}`);
    }
  });
}
