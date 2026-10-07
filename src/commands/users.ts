import { ObjectId } from "mongodb";
import type { Telegraf } from "telegraf";
import { getDatabase, getMongoClient } from "../db/client.js";
import { ensureAdminControlIndexes } from "../db/indexes.js";
import { parseReasonedCommand, queueAdminAction } from "../domain/pendingActions.js";
import { escapeHtml } from "../security/telegramHtml.js";

export function registerUserCommands(bot: Telegraf<any>) {
  // /user <email>
  bot.command("user", async (ctx) => {
    try {
      const text = ctx.message.text.trim();
      const parts = text.split(/\s+/);
      if (parts.length < 2) {
        return ctx.reply("⚠️ Usage: <code>/user &lt;email&gt;</code>", { parse_mode: "HTML" });
      }

      const email = parts[1].toLowerCase().trim();
      const database = await getDatabase();
      const user = await database.collection("users").findOne({ email });

      if (!user) {
        return ctx.reply(`❌ No user found with email: <code>${escapeHtml(email)}</code>`, { parse_mode: "HTML" });
      }

      const createdAt = user.created_at ? new Date(user.created_at).toLocaleString("en-IN") : "Unknown";
      const dedicatedApiKeyCount = await database.collection("api_keys").countDocuments({
        user_id: user._id,
        status: { $ne: "archived" },
      });
      const apiKeyCount = dedicatedApiKeyCount || (user.api_key || user.api_key_hash ? 1 : 0);

      const userDetails = `
  👤 <b>User Profile:</b> <code>${escapeHtml(user.email)}</code>
  🆔 <b>User ID:</b> <code>${user._id.toString()}</code>
  💰 <b>Current Balance:</b> <code>₹${Number(user.balance || 0).toFixed(2)}</code>
  💸 <b>Total Spent:</b> <code>₹${Number(user.total_spent || 0).toFixed(2)}</code>
  📦 <b>Orders Placed:</b> <code>${Number(user.total_orders || 0)}</code>
  🔑 <b>API Keys:</b> <code>${apiKeyCount > 0 ? `${apiKeyCount} active/paused identities` : "None"}</code>
  📅 <b>Registered At:</b> <code>${createdAt}</code>
  `;
      await ctx.reply(userDetails, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🖥 Sessions", callback_data: `d:sessions:${user._id.toString()}:0` },
              { text: user.account_locked ? "Support Access unavailable while locked" : "👁 Support Access", callback_data: user.account_locked ? "d:noop" : `d:support:${user._id.toString()}` },
            ],
            [
              { text: "🛡 Account Controls", callback_data: `d:controls:${user._id.toString()}` },
              { text: "🔑 API Keys", callback_data: `d:keys:${user._id.toString()}:0` },
            ],
            [
              { text: "📦 Orders", callback_data: `d:records:orders:${user._id.toString()}:0` },
              { text: "💳 Transactions", callback_data: `d:records:deposits:${user._id.toString()}:0` },
            ],
            [
              { text: "📒 Wallet", callback_data: `d:records:wallet:${user._id.toString()}:0` },
              { text: "🛡 Events", callback_data: `d:records:events:${user._id.toString()}:0` },
            ],
            [{ text: "🚫 Revoke All Sessions", callback_data: `sessions-revoke-prompt:${user._id.toString()}` }],
            [{ text: "🏠 Dashboard", callback_data: "d:home" }],
          ],
        },
      });
    } catch (err: any) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  bot.action(/^user-sessions:([a-f0-9]{24})$/, async (ctx) => {
    try {
      const database = await getDatabase();
      const userId = new ObjectId(ctx.match[1]);
      const user: any = await database.collection("users").findOne({ _id: userId });
      if (!user) return ctx.answerCbQuery("User no longer exists.", { show_alert: true });
      const now = new Date();
      const sessions: any[] = await database.collection("sessions").find({
        $or: [{ user_id: userId }, { actor_admin_id: userId }],
        revoked_at: null,
        expires_at: { $gt: now },
      }).sort({ last_activity_at: -1 }).limit(20).toArray();
      const restrictedCount = await database.collection("restricted_sessions").countDocuments({
        user_id: userId,
        invalidated_at: null,
        expires_at: { $gt: now },
      });
      await ctx.answerCbQuery(`${sessions.length} active website session${sessions.length === 1 ? "" : "s"}.`);
      if (!sessions.length && !restrictedCount) {
        return ctx.reply(`🖥 No active website sessions for <code>${escapeHtml(user.email)}</code>.`, { parse_mode: "HTML" });
      }
      await ctx.reply(
        `🖥 <b>Active Sessions</b>\nUser: <code>${escapeHtml(user.email)}</code>\n` +
        `Normal/support: <code>${sessions.length}</code> · Restricted recovery: <code>${restrictedCount}</code>`,
        { parse_mode: "HTML" },
      );
      for (const session of sessions) {
        const device = session.device || {};
        const type = session.purpose === "admin_impersonation"
          ? `Owner Support viewing @${escapeHtml(session.username || "user")} (read-only)`
          : "Normal login";
        await ctx.reply(
          `🔹 <b>${type}</b>\n` +
          `Session: <code>${session._id.toString()}</code>\n` +
          `Created: <code>${new Date(session.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</code>\n` +
          `Last activity: <code>${new Date(session.last_activity_at || session.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</code>\n` +
          `Expires: <code>${new Date(session.expires_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</code>\n` +
          `Device: <code>${escapeHtml(String(device.platform || device.user_agent || "Unknown").slice(0, 160))}</code>`,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "Revoke this session", callback_data: `session-revoke-prompt:${session._id.toString()}` }]] },
          },
        );
      }
    } catch (error: any) {
      await ctx.answerCbQuery(`Failed: ${String(error.message).slice(0, 120)}`, { show_alert: true });
    }
  });

  bot.action(/^user-support:([a-f0-9]{24})$/, async (ctx) => {
    try {
      const database = await getDatabase();
      const user: any = await database.collection("users").findOne({ _id: new ObjectId(ctx.match[1]) });
      if (!user) return ctx.answerCbQuery("User no longer exists.", { show_alert: true });
      await ctx.answerCbQuery("Add the verified support reason before issuing access.");
      await ctx.reply(
        `👁 <b>Create read-only Support Access</b>\n\n` +
        `Send:\n<code>/supportaccess ${escapeHtml(user.email)} | describe the verified support reason</code>\n\n` +
        `<i>The one-time code lasts five minutes; the resulting website session lasts 15 minutes.</i>`,
        { parse_mode: "HTML" },
      );
    } catch (error: any) {
      await ctx.answerCbQuery(`Failed: ${String(error.message).slice(0, 120)}`, { show_alert: true });
    }
  });

  bot.action(/^user-controls:([a-f0-9]{24})$/, async (ctx) => {
    try {
      const database = await getDatabase();
      const user: any = await database.collection("users").findOne({ _id: new ObjectId(ctx.match[1]) });
      if (!user) return ctx.answerCbQuery("User no longer exists.", { show_alert: true });
      await ctx.answerCbQuery("Current account controls loaded.");
      await ctx.reply(
        `🛡 <b>Account Controls</b>\nUser: <code>${escapeHtml(user.email)}</code>\n\n` +
        `Account: <b>${user.account_locked ? "LOCKED" : "ACTIVE"}</b>\n` +
        `Ordering: <b>${user.ordering_hold ? "HELD" : "ALLOWED"}</b>\n` +
        `Payments: <b>${user.payment_hold ? "HELD" : "ALLOWED"}</b>\n\n` +
        `<code>/${user.account_locked ? "unlock" : "lock"} ${escapeHtml(user.email)} | exact reason</code>\n` +
        `<code>/${user.ordering_hold ? "orderrelease" : "orderhold"} ${escapeHtml(user.email)} | exact reason</code>\n` +
        `<code>/${user.payment_hold ? "paymentrelease" : "paymenthold"} ${escapeHtml(user.email)} | exact reason</code>`,
        { parse_mode: "HTML" },
      );
    } catch (error: any) {
      await ctx.answerCbQuery(`Failed: ${String(error.message).slice(0, 100)}`, { show_alert: true });
    }
  });

  bot.action(/^user-keys:([a-f0-9]{24})$/, async (ctx) => {
    try {
      const database = await getDatabase();
      const user: any = await database.collection("users").findOne({ _id: new ObjectId(ctx.match[1]) });
      if (!user) return ctx.answerCbQuery("User no longer exists.", { show_alert: true });
      const keys: any[] = await database.collection("api_keys").find({ user_id: user._id }).sort({ created_at: -1 }).limit(20).toArray();
      await ctx.answerCbQuery(`${keys.length} API key record${keys.length === 1 ? "" : "s"}.`);
      if (!keys.length) return ctx.reply("No dedicated API-key identities found.");
      for (const key of keys) {
        await ctx.reply(
          `🔑 <b>${escapeHtml(key.name)}</b> · ${escapeHtml(key.status)}\n` +
          `ID: <code>${key._id.toString()}</code>\nPublic: <code>${escapeHtml(key.public_id || key.prefix || "n/a")}</code>\n` +
          `Scopes: <code>${escapeHtml((key.scopes || []).join(", "))}</code>\n` +
          `Last used: <code>${key.last_used_at ? new Date(key.last_used_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "Never"}</code>\n\n` +
          `<code>/key${key.status === "paused" ? "resume" : "pause"} ${key._id.toString()} | exact reason</code>\n` +
          `<code>/keyreissue ${key._id.toString()} | compromised; require user reissue</code>\n` +
          `<code>/keyarchive ${key._id.toString()} | exact reason</code>`,
          { parse_mode: "HTML" },
        );
      }
    } catch (error: any) {
      await ctx.answerCbQuery(`Failed: ${String(error.message).slice(0, 100)}`, { show_alert: true });
    }
  });

  bot.action(/^user-records:([a-f0-9]{24})$/, async (ctx) => {
    try {
      const database = await getDatabase();
      const user: any = await database.collection("users").findOne({ _id: new ObjectId(ctx.match[1]) });
      if (!user) return ctx.answerCbQuery("User no longer exists.", { show_alert: true });
      const [orders, deposits, ledger, events, notes] = await Promise.all([
        database.collection("orders").countDocuments({ user_id: user._id }),
        database.collection("transactions").countDocuments({ user_id: user._id }),
        database.collection("wallet_ledger").countDocuments({ user_id: user._id }),
        database.collection("security_events").countDocuments({ user_id: user._id }),
        database.collection("admin_notes").countDocuments({ user_id: user._id }),
      ]);
      await ctx.answerCbQuery("Operational record counts loaded.");
      await ctx.reply(
        `📒 <b>User Records</b>\nUser: <code>${escapeHtml(user.email)}</code>\n` +
        `Orders: <code>${orders}</code> · Deposits: <code>${deposits}</code> · Ledger: <code>${ledger}</code>\n` +
        `Security events: <code>${events}</code> · Admin notes: <code>${notes}</code>\n\n` +
        `<code>/userorders ${escapeHtml(user.email)}</code>\n<code>/deposits ${escapeHtml(user.email)}</code>\n` +
        `<code>/wallet ${escapeHtml(user.email)}</code>\n<code>/events ${escapeHtml(user.email)}</code>`,
        { parse_mode: "HTML" },
      );
    } catch (error: any) {
      await ctx.answerCbQuery(`Failed: ${String(error.message).slice(0, 100)}`, { show_alert: true });
    }
  });

  bot.action(/^session-revoke-prompt:([a-f0-9]{24})$/, async (ctx) => {
    await ctx.answerCbQuery("Confirm session revocation.");
    await ctx.reply("⚠️ Revoke this website session now?", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Revoke", callback_data: `session-revoke-confirm:${ctx.match[1]}` },
            { text: "Cancel", callback_data: "session-revoke-cancel" },
          ],
          [{ text: "🏠 Dashboard", callback_data: "d:home" }],
        ],
      },
    });
  });

  bot.action("session-revoke-cancel", async (ctx) => {
    await ctx.answerCbQuery("Cancelled.");
    await ctx.editMessageText("Revocation cancelled.", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 Dashboard", callback_data: "d:home" }]] },
    });
  });

  bot.action(/^session-revoke-confirm:([a-f0-9]{24})$/, async (ctx) => {
    try {
      const database = await getDatabase();
      const sessionId = new ObjectId(ctx.match[1]);
      const now = new Date();
      const websiteSession: any = await database.collection("sessions").findOne({ _id: sessionId });
      if (!websiteSession) return ctx.answerCbQuery("Session no longer exists.", { show_alert: true });
      const result = await database.collection("sessions").updateOne(
        { _id: sessionId, revoked_at: null },
        { $set: { revoked_at: now, revoked_reason: "owner_telegram_revoke" } },
      );
      if (websiteSession.support_access_code_id) {
        await database.collection("support_access_codes").updateOne(
          { _id: websiteSession.support_access_code_id },
          {
            $set: {
              support_session_status: "revoked",
              support_session_ended_at: now,
              telegram_status_retry_required: true,
            },
          },
        );
      }
      await database.collection("security_events").insertOne({
        user_id: websiteSession.user_id,
        session_id: sessionId,
        type: "session_revoked_by_owner",
        owner_telegram_id: ctx.from?.id,
        created_at: now,
      });
      await ctx.answerCbQuery(result.modifiedCount ? "Session revoked." : "Session was already inactive.");
      await ctx.editMessageText(result.modifiedCount ? "✅ Website session revoked." : "ℹ️ Session was already inactive.", {
        reply_markup: { inline_keyboard: [[{ text: "🏠 Dashboard", callback_data: "d:home" }]] },
      });
    } catch (error: any) {
      await ctx.answerCbQuery(`Failed: ${String(error.message).slice(0, 120)}`, { show_alert: true });
    }
  });

  bot.action(/^sessions-revoke-prompt:([a-f0-9]{24})$/, async (ctx) => {
    await ctx.answerCbQuery("Confirm global session revocation.");
    await ctx.reply("⚠️ Revoke every normal, recovery and Support Access session connected to this account?", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Revoke all", callback_data: `sessions-revoke-confirm:${ctx.match[1]}` },
            { text: "Cancel", callback_data: "session-revoke-cancel" },
          ],
          [{ text: "🏠 Dashboard", callback_data: "d:home" }],
        ],
      },
    });
  });

  bot.action(/^sessions-revoke-confirm:([a-f0-9]{24})$/, async (ctx) => {
    try {
      const database = await getDatabase();
      const mongoClient = getMongoClient();
      if (!mongoClient) throw new Error("Database client unavailable");
      const userId = new ObjectId(ctx.match[1]);
      const now = new Date();
      const mongoSession = mongoClient.startSession();
      let revokedCount = 0;
      try {
        await mongoSession.withTransaction(async () => {
          const user: any = await database.collection("users").findOne({ _id: userId }, { session: mongoSession });
          if (!user) throw new Error("User no longer exists.");
          const affectedSupportSessions: any[] = await database.collection("sessions").find({
            $or: [{ user_id: userId }, { actor_admin_id: userId }],
            purpose: "admin_impersonation",
            revoked_at: null,
          }, { session: mongoSession }).project({ support_access_code_id: 1 }).toArray();
          const result = await database.collection("sessions").updateMany(
            { $or: [{ user_id: userId }, { actor_admin_id: userId }], revoked_at: null },
            { $set: { revoked_at: now, revoked_reason: "owner_telegram_global_revoke" } },
            { session: mongoSession },
          );
          revokedCount = result.modifiedCount;
          await database.collection("restricted_sessions").updateMany(
            { user_id: userId, invalidated_at: null },
            { $set: { invalidated_at: now, invalidation_reason: "owner_telegram_global_revoke" } },
            { session: mongoSession },
          );
          await database.collection("users").updateOne(
            { _id: userId },
            { $set: { sessions_revoked_before: now, updated_at: now } },
            { session: mongoSession },
          );
          const codeIds = affectedSupportSessions.map((item) => item.support_access_code_id).filter(Boolean);
          if (codeIds.length) {
            await database.collection("support_access_codes").updateMany(
              { _id: { $in: codeIds } },
              {
                $set: {
                  support_session_status: "revoked",
                  support_session_ended_at: now,
                  telegram_status_retry_required: true,
                },
              },
              { session: mongoSession },
            );
          }
          await database.collection("security_events").insertOne({
            user_id: userId,
            type: "all_sessions_revoked_by_owner",
            owner_telegram_id: ctx.from?.id,
            revoked_count: revokedCount,
            created_at: now,
          }, { session: mongoSession });
        });
      } finally {
        await mongoSession.endSession();
      }
      await ctx.answerCbQuery(`${revokedCount} session${revokedCount === 1 ? "" : "s"} revoked.`);
      await ctx.editMessageText(`✅ Revoked ${revokedCount} active website session${revokedCount === 1 ? "" : "s"}.`, {
        reply_markup: { inline_keyboard: [[{ text: "🏠 Dashboard", callback_data: "d:home" }]] },
      });
    } catch (error: any) {
      await ctx.answerCbQuery(`Failed: ${String(error.message).slice(0, 120)}`, { show_alert: true });
    }
  });

  for (const [command, type] of [
    ["lock", "account_lock"], ["unlock", "account_unlock"],
    ["orderhold", "ordering_hold"], ["orderrelease", "ordering_release"],
    ["paymenthold", "payment_hold"], ["paymentrelease", "payment_release"],
  ] as const) {
    bot.command(command, async (ctx) => {
      try {
        const parsed = parseReasonedCommand(ctx.message.text, command);
        if (!parsed || parsed.left.length !== 1) {
          return ctx.reply(`⚠️ Usage: <code>/${command} user@example.com | exact reason</code>`, { parse_mode: "HTML" });
        }
        const database = await getDatabase();
        const user: any = await database.collection("users").findOne({ email: parsed.left[0].toLowerCase() });
        if (!user) return ctx.reply("❌ User not found.");
        await queueAdminAction(ctx, type, { user_id: user._id.toString(), reason: parsed.reason },
          `🛡 <b>Confirm ${escapeHtml(type.replace(/_/g, " "))}</b>\nUser: <code>${escapeHtml(user.email)}</code>\nReason: ${escapeHtml(parsed.reason)}`);
      } catch (error: any) {
        await ctx.reply(`❌ ${escapeHtml(error.message)}`, { parse_mode: "HTML" });
      }
    });
  }

  for (const [command, type] of [
    ["keypause", "api_pause"], ["keyresume", "api_resume"],
    ["keyarchive", "api_archive"], ["keyreissue", "api_reissue_required"],
  ] as const) {
    bot.command(command, async (ctx) => {
      try {
        const parsed = parseReasonedCommand(ctx.message.text, command);
        if (!parsed || parsed.left.length !== 1 || !ObjectId.isValid(parsed.left[0])) {
          return ctx.reply(`⚠️ Usage: <code>/${command} &lt;keyId&gt; | exact reason</code>`, { parse_mode: "HTML" });
        }
        const database = await getDatabase();
        const key: any = await database.collection("api_keys").findOne({ _id: new ObjectId(parsed.left[0]) });
        if (!key) return ctx.reply("❌ API key not found.");
        await queueAdminAction(ctx, type, { key_id: key._id.toString(), user_id: key.user_id.toString(), reason: parsed.reason },
          `🔑 <b>Confirm ${escapeHtml(type.replace("api_", "").replace(/_/g, " "))}</b>\nKey: <code>${escapeHtml(key.name)}</code>\nPublic ID: <code>${escapeHtml(key.public_id || key.prefix)}</code>\nReason: ${escapeHtml(parsed.reason)}\n\n<i>No raw API secret will be sent through Telegram.</i>`);
      } catch (error: any) {
        await ctx.reply(`❌ ${escapeHtml(error.message)}`, { parse_mode: "HTML" });
      }
    });
  }

  bot.command("note", async (ctx) => {
    try {
      const parsed = parseReasonedCommand(ctx.message.text, "note");
      if (!parsed || parsed.left.length !== 1) return ctx.reply("⚠️ Usage: <code>/note user@example.com | administrative note</code>", { parse_mode: "HTML" });
      const database = await getDatabase();
      await ensureAdminControlIndexes(database);
      const user: any = await database.collection("users").findOne({ email: parsed.left[0].toLowerCase() });
      if (!user) return ctx.reply("❌ User not found.");
      const now = new Date();
      await Promise.all([
        database.collection("admin_notes").insertOne({ user_id: user._id, note: parsed.reason, actor_telegram_id: String(ctx.from?.id), created_at: now }),
        database.collection("admin_audit").insertOne({ action_type: "admin_note_added", actor_telegram_id: String(ctx.from?.id), subject_user_id: user._id, outcome: "completed", details: { note: parsed.reason }, created_at: now }),
      ]);
      await ctx.reply(`✅ Note added for <code>${escapeHtml(user.email)}</code>.`, { parse_mode: "HTML" });
    } catch (error: any) {
      await ctx.reply(`❌ ${escapeHtml(error.message)}`, { parse_mode: "HTML" });
    }
  });

  for (const command of ["userorders", "deposits", "wallet", "events"] as const) {
    bot.command(command, async (ctx) => {
      try {
        const email = ctx.message.text.trim().split(/\s+/)[1]?.toLowerCase();
        if (!email) return ctx.reply(`⚠️ Usage: <code>/${command} user@example.com</code>`, { parse_mode: "HTML" });
        const database = await getDatabase();
        const user: any = await database.collection("users").findOne({ email });
        if (!user) return ctx.reply("❌ User not found.");
        if (command === "userorders") {
          const records: any[] = await database.collection("orders").find({ user_id: user._id }).sort({ created_at: -1 }).limit(10).toArray();
          if (!records.length) return ctx.reply("No orders for this user.");
          for (const item of records) await ctx.reply(
            `📦 <b>${escapeHtml(item.status)}</b> · <code>${item._id.toString()}</code>\nProvider: <code>${escapeHtml(item.provider_order_id || "not accepted")}</code>\n` +
            `Service: ${escapeHtml(item.service_name || item.service_id)}\nTarget: <code>${escapeHtml(item.link)}</code>\n` +
            `Quantity: <code>${item.quantity || 0}</code> · Charge: <code>₹${Number(item.charge || 0).toFixed(2)}</code>\nRefund: <code>${escapeHtml(item.refund_status || "none")}</code>`,
            { parse_mode: "HTML" },
          );
        } else if (command === "deposits") {
          const records: any[] = await database.collection("transactions").find({ user_id: user._id }).sort({ created_at: -1 }).limit(15).toArray();
          if (!records.length) return ctx.reply("No deposit/transaction records for this user.");
          for (const item of records) await ctx.reply(
            `💳 <b>${escapeHtml(item.status)}</b> · ${escapeHtml(item.method || item.type || "transaction")}\nID: <code>${item._id.toString()}</code>\n` +
            `Amount: <code>₹${Number(item.amount || 0).toFixed(2)}</code> · Memo: <code>${escapeHtml(item.memo || "—")}</code>\n` +
            `UTR/Payment: <code>${escapeHtml(item.utr || item.razorpay_payment_id || item.transaction_id || "—")}</code>`,
            { parse_mode: "HTML" },
          );
        } else if (command === "wallet") {
          const records: any[] = await database.collection("wallet_ledger").find({ user_id: user._id }).sort({ created_at: -1 }).limit(20).toArray();
          if (!records.length) return ctx.reply("No wallet-ledger records for this user.");
          let text = `📒 <b>Wallet Ledger</b> · <code>${escapeHtml(user.email)}</code>\nBalance: <b>₹${Number(user.balance || 0).toFixed(2)}</b>\n\n`;
          for (const item of records) text += `${Number(item.amount || 0) >= 0 ? "+" : ""}₹${Number(item.amount || 0).toFixed(2)} · ${escapeHtml(item.type)} · <code>${escapeHtml(item.settlement_key || item._id.toString())}</code>\n`;
          await ctx.reply(text.slice(0, 3900), { parse_mode: "HTML" });
        } else {
          const [events, notes] = await Promise.all([
            database.collection("security_events").find({ user_id: user._id }).sort({ created_at: -1 }).limit(15).toArray(),
            database.collection("admin_notes").find({ user_id: user._id }).sort({ created_at: -1 }).limit(10).toArray(),
          ]);
          let text = `🛡 <b>Security & Admin Record</b> · <code>${escapeHtml(user.email)}</code>\n\n`;
          for (const event of events) text += `• ${escapeHtml(event.type)} · <code>${new Date(event.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</code>\n`;
          for (const note of notes) text += `📝 ${escapeHtml(note.note)}\n`;
          await ctx.reply(text.slice(0, 3900), { parse_mode: "HTML" });
        }
      } catch (error: any) {
        await ctx.reply(`❌ ${escapeHtml(error.message)}`, { parse_mode: "HTML" });
      }
    });
  }
}
