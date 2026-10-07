import crypto from "crypto";
import bcrypt from "bcryptjs";
import { ObjectId } from "mongodb";
import type { Telegraf } from "telegraf";
import { temporaryPasswordMaxUses, temporaryPasswordTtlMinutes } from "../config.js";
import { getDatabase, getMongoClient } from "../db/client.js";
import { ensureAdminControlIndexes } from "../db/indexes.js";
import { decryptAdminStateSecret, encryptAdminStateSecret, generateTemporaryPassword, hashActionToken } from "../security/adminState.js";
import { escapeHtml } from "../security/telegramHtml.js";

export function registerRecoveryCommands(bot: Telegraf<any>) {
  // /resetpassword <email> <auto|custom-password> | <mandatory reason>
  bot.command("resetpassword", async (ctx) => {
    try {
      const rawInput = ctx.message.text.replace(/^\/resetpassword(?:@\w+)?\s*/i, "").trim();
      const separator = rawInput.indexOf("|");
      if (separator < 0) {
        return ctx.reply(
          "⚠️ Usage:\n<code>/resetpassword user@example.com auto | verified recent order and deposit</code>\n\n" +
          "For an owner-selected value, replace <code>auto</code> with the temporary password.",
          { parse_mode: "HTML" },
        );
      }
      const commandPart = rawInput.slice(0, separator).trim();
      const reason = rawInput.slice(separator + 1).trim();
      const [emailRaw, modeRaw] = commandPart.split(/\s+/, 2);
      const email = String(emailRaw || "").trim().toLowerCase();
      const mode = String(modeRaw || "").trim();
      if (!email || !mode || reason.length < 5) {
        return ctx.reply("❌ Email, auto/custom temporary password and a meaningful reason are required.");
      }

      const database = await getDatabase();
      const user: any = await database.collection("users").findOne({ email });
      if (!user) return ctx.reply("❌ No user exists with that email.");

      const generatedMode = mode.toLowerCase() === "auto";
      if (!generatedMode) {
        if (mode.length < 10 || mode.length > 128) {
          return ctx.reply("❌ A custom temporary password must be 10–128 characters.");
        }
        const categories = [/[a-z]/.test(mode), /[A-Z]/.test(mode), /\d/.test(mode), /[^A-Za-z0-9]/.test(mode)]
          .filter(Boolean).length;
        if (categories < 3) return ctx.reply("❌ Custom temporary password must use at least three character categories.");
      }

      const rawActionToken = crypto.randomBytes(16).toString("hex");
      const tokenHash = hashActionToken(rawActionToken);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 5 * 60_000);
      await ensureAdminControlIndexes(database);
      await database.collection("admin_action_tokens").insertOne({
        token_hash: tokenHash,
        action: "password_reset",
        actor_telegram_id: ctx.from?.id,
        user_id: user._id,
        user_email: user.email,
        username: user.username,
        mode: generatedMode ? "generated" : "owner_selected",
        custom_password_hash: generatedMode ? null : await bcrypt.hash(mode, 12),
        custom_password_encrypted: generatedMode ? null : encryptAdminStateSecret(mode),
        reason,
        created_at: now,
        expires_at: expiresAt,
        consumed_at: null,
        cancelled_at: null,
      });

      await ctx.reply(
        `⚠️ <b>Confirm Temporary-Password Reset</b>\n\n` +
        `User: <code>@${escapeHtml(user.username)}</code>\n` +
        `Email: <code>${escapeHtml(user.email)}</code>\n` +
        `Mode: <code>${generatedMode ? "Generate automatically" : "Owner-selected"}</code>\n` +
        `Lifetime: <code>${temporaryPasswordTtlMinutes()} minutes</code>\n` +
        `Maximum uses: <code>${temporaryPasswordMaxUses()}</code>\n` +
        `Reason: ${escapeHtml(reason)}\n\n` +
        `<b>Identity checklist — verify at least two:</b>\n` +
        `□ Registered email\n□ Recent internal order + target\n□ Recent service/quantity\n□ Deposit amount + UTR/reference\n□ Approximate balance/registration date\n\n` +
        `<i>Confirming attests that the private recovery evidence was checked. Confirmation expires in 5 minutes; existing sessions will be revoked.</i>`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Confirm reset", callback_data: `pwdreset-confirm:${rawActionToken}` },
              { text: "✖ Cancel", callback_data: `pwdreset-cancel:${rawActionToken}` },
            ]],
          },
        },
      );
    } catch (error: any) {
      console.error("[AdminBot] Reset preparation failed:", error);
      await ctx.reply("❌ Could not prepare the reset safely.");
    }
  });

  bot.action(/^pwdreset-(confirm|cancel):([a-f0-9]{32})$/, async (ctx) => {
    const mode = ctx.match[1];
    const rawToken = ctx.match[2];
    const tokenHash = hashActionToken(rawToken);
    try {
      const database = await getDatabase();
      const action: any = await database.collection("admin_action_tokens").findOne({
        token_hash: tokenHash,
        action: "password_reset",
        actor_telegram_id: ctx.from?.id,
        consumed_at: null,
        cancelled_at: null,
        expires_at: { $gt: new Date() },
      });
      if (!action) {
        await ctx.answerCbQuery("This confirmation expired or was already used.", { show_alert: true });
        return;
      }
      if (mode === "cancel") {
        await database.collection("admin_action_tokens").updateOne(
          { _id: action._id, consumed_at: null },
          { $set: { cancelled_at: new Date() }, $unset: { custom_password_encrypted: "", custom_password_hash: "" } },
        );
        await ctx.editMessageText("✖ Temporary-password reset cancelled.");
        await ctx.answerCbQuery("Cancelled");
        return;
      }

      const temporaryPassword = action.mode === "generated"
        ? generateTemporaryPassword()
        : decryptAdminStateSecret(action.custom_password_encrypted);
      if (!temporaryPassword) {
        await ctx.answerCbQuery("The protected action state is unavailable. Start again.", { show_alert: true });
        return;
      }
      const passwordHash = action.custom_password_hash || await bcrypt.hash(temporaryPassword, 12);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + temporaryPasswordTtlMinutes() * 60_000);
      const maxUses = temporaryPasswordMaxUses();
      const message: any = ctx.callbackQuery.message;
      const chatId = message?.chat?.id;
      const messageId = message?.message_id;
      const mongoClient = getMongoClient();
      if (!chatId || !messageId || !mongoClient) throw new Error("Reset message or database client unavailable");

      const session = mongoClient.startSession();
      let temporaryId: ObjectId | null = null;
      try {
        await session.withTransaction(async () => {
          const claimed: any = await database.collection("admin_action_tokens").findOneAndUpdate(
            {
              _id: action._id,
              consumed_at: null,
              cancelled_at: null,
              expires_at: { $gt: now },
            },
            {
              $set: { consumed_at: now, identity_checklist_attested: true },
              $unset: { custom_password_encrypted: "", custom_password_hash: "" },
            },
            { returnDocument: "after", session },
          );
          if (!claimed) throw new Error("RESET_TOKEN_ALREADY_USED");

          await database.collection("temporary_passwords").updateMany(
            { user_id: action.user_id, invalidated_at: null },
            { $set: { status: "superseded", invalidated_at: now, invalidation_reason: "new_reset" } },
            { session },
          );
          const inserted = await database.collection("temporary_passwords").insertOne({
            user_id: action.user_id,
            user_email: action.user_email,
            username: action.username,
            password_hash: passwordHash,
            status: "active",
            used_count: 0,
            max_uses: maxUses,
            created_at: now,
            expires_at: expiresAt,
            invalidated_at: null,
            invalidation_reason: null,
            reason: action.reason,
            created_by_telegram_id: ctx.from?.id,
            action_token_id: action._id,
            telegram_chat_id: chatId,
            telegram_message_id: messageId,
            usage_events: [],
          }, { session });
          temporaryId = inserted.insertedId;

          const affectedSupportSessions: any[] = await database.collection("sessions").find({
            $or: [{ user_id: action.user_id }, { actor_admin_id: action.user_id }],
            purpose: "admin_impersonation",
            revoked_at: null,
          }, { session }).project({ support_access_code_id: 1 }).toArray();
          await database.collection("sessions").updateMany(
            {
              $or: [{ user_id: action.user_id }, { actor_admin_id: action.user_id }],
              revoked_at: null,
            },
            { $set: { revoked_at: now, revoked_reason: "owner_password_reset" } },
            { session },
          );
          const supportCodeIds = affectedSupportSessions.map((item) => item.support_access_code_id).filter(Boolean);
          if (supportCodeIds.length) {
            await database.collection("support_access_codes").updateMany(
              { _id: { $in: supportCodeIds } },
              {
                $set: {
                  support_session_status: "revoked",
                  support_session_ended_at: now,
                  telegram_status_retry_required: true,
                },
              },
              { session },
            );
          }
          await database.collection("restricted_sessions").updateMany(
            { user_id: action.user_id, invalidated_at: null },
            { $set: { invalidated_at: now, invalidation_reason: "owner_password_reset" } },
            { session },
          );
          await database.collection("users").updateOne(
            { _id: action.user_id },
            { $set: { sessions_revoked_before: now, updated_at: now } },
            { session },
          );
          await database.collection("security_events").insertOne({
            user_id: action.user_id,
            type: "temporary_password_created",
            temporary_password_id: inserted.insertedId,
            actor_telegram_id: ctx.from?.id,
            reason: action.reason,
            identity_checklist_attested: true,
            expires_at: expiresAt,
            max_uses: maxUses,
            created_at: now,
          }, { session });
        });
      } finally {
        await session.endSession();
      }

      try {
        await ctx.editMessageText(
          `🔐 <b>Temporary Password Created</b>\n\n` +
          `User: <code>@${escapeHtml(action.username)}</code>\n` +
          `Email: <code>${escapeHtml(action.user_email)}</code>\n` +
          `Temporary password: <code>${escapeHtml(temporaryPassword)}</code>\n` +
          `Expires: <code>${expiresAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</code>\n` +
          `Uses: <code>0/${maxUses}</code>\n` +
          `Status: ⏳ Waiting for user\n` +
          `Reason: ${escapeHtml(action.reason)}\n\n` +
          `<i>Credential ID: ${temporaryId?.toString() || "recorded"}. The permanent password remains unreadable.</i>`,
          { parse_mode: "HTML" },
        );
      } catch (deliveryError) {
        if (temporaryId) {
          await database.collection("temporary_passwords").updateOne(
            { _id: temporaryId },
            {
              $set: {
                status: "delivery_failed",
                invalidated_at: new Date(),
                invalidation_reason: "telegram_delivery_failed",
              },
            },
          );
        }
        throw deliveryError;
      }
      await ctx.answerCbQuery("Temporary password created; sessions revoked.");
    } catch (error: any) {
      console.error("[AdminBot] Password reset failed:", error);
      await ctx.answerCbQuery("Reset failed safely. Check logs.", { show_alert: true });
    }
  });

  // /supportaccess <email> | <mandatory reason>
  bot.command("supportaccess", async (ctx) => {
    let insertedId: ObjectId | null = null;
    try {
      const rawInput = ctx.message.text.replace(/^\/supportaccess(?:@\w+)?\s*/i, "").trim();
      const separator = rawInput.indexOf("|");
      if (separator < 0) {
        return ctx.reply(
          "⚠️ Usage: <code>/supportaccess user@example.com | investigate reported order display</code>",
          { parse_mode: "HTML" },
        );
      }
      const email = rawInput.slice(0, separator).trim().toLowerCase();
      const reason = rawInput.slice(separator + 1).trim();
      if (!email || reason.length < 5) return ctx.reply("❌ Email and a meaningful support reason are required.");
      if (reason.length > 500) return ctx.reply("❌ Support reason must be 500 characters or fewer.");

      const database = await getDatabase();
      const user: any = await database.collection("users").findOne({ email });
      if (!user) return ctx.reply("❌ No user exists with that email.");
      if (user.account_locked === true) return ctx.reply("❌ Support Access is unavailable while this account is locked.");
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const part = () => Array.from({ length: 4 }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join("");
      const rawCode = `SUP-${part()}-${part()}-${part()}-${part()}`;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 5 * 60_000);

      await Promise.all([
        database.collection("support_access_codes").createIndex({ code_hash: 1 }, { unique: true }),
        database.collection("support_access_codes").createIndex(
          { subject_user_id: 1 },
          {
            unique: true,
            partialFilterExpression: { consumed_at: null, invalidated_at: null },
            name: "one_active_support_code_per_subject",
          },
        ),
        database.collection("support_access_codes").createIndex({ expires_at: 1 }, { expireAfterSeconds: 60 * 60 * 24 }),
      ]);
      await database.collection("support_access_codes").updateMany(
        { subject_user_id: user._id, consumed_at: null, invalidated_at: null },
        {
          $set: {
            invalidated_at: now,
            invalidation_reason: "new_code_issued",
            telegram_status_retry_required: true,
          },
        },
      );
      const inserted = await database.collection("support_access_codes").insertOne({
        code_hash: hashActionToken(rawCode),
        subject_user_id: user._id,
        subject_username: user.username,
        subject_email: user.email,
        reason,
        created_by_telegram_id: ctx.from?.id,
        created_at: now,
        expires_at: expiresAt,
        consumed_at: null,
        invalidated_at: null,
      });
      insertedId = inserted.insertedId;

      const sent: any = await ctx.reply(
        `👁 <b>Support Access Code Created</b>\n\n` +
        `User: <code>@${escapeHtml(user.username)}</code>\n` +
        `Email: <code>${escapeHtml(user.email)}</code>\n` +
        `Code: <code>${rawCode}</code>\n` +
        `Exchange by: <code>${expiresAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</code>\n` +
        `Website session: <code>15 minutes</code>\n` +
        `Permissions: <b>Read-only</b>\n` +
        `Reason: ${escapeHtml(reason)}\n\n` +
        `<i>Enter this once at https://smmup.co.in/support-access while signed in as owner. The code is stored only as a hash.</i>`,
        { parse_mode: "HTML" },
      );
      await database.collection("support_access_codes").updateOne(
        { _id: inserted.insertedId },
        {
          $set: {
            telegram_chat_id: sent.chat?.id || ctx.chat?.id,
            telegram_message_id: sent.message_id,
          },
        },
      );
    } catch (error: any) {
      console.error("[AdminBot] Support Access creation failed:", error);
      if (insertedId) {
        const database = await getDatabase().catch(() => null);
        await database?.collection("support_access_codes").updateOne(
          { _id: insertedId },
          { $set: { invalidated_at: new Date(), invalidation_reason: "telegram_delivery_failed" } },
        ).catch(() => {});
      }
      await ctx.reply("❌ Could not create Support Access safely.");
    }
  });
}
