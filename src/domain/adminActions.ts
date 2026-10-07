import { ObjectId, type Db } from "mongodb";
import { escapeHtml } from "../security/telegramHtml.js";

async function appendAdminAudit(database: Db, session: any, action: any, outcome: string, details: Record<string, any> = {}) {
  await database.collection("admin_audit").insertOne({
    action_id: action._id,
    action_type: action.type,
    actor_telegram_id: action.actor_telegram_id,
    actor_username: action.actor_username || null,
    subject_user_id: action.payload?.user_id && ObjectId.isValid(action.payload.user_id)
      ? new ObjectId(action.payload.user_id)
      : null,
    outcome,
    details,
    created_at: new Date(),
  }, { session });
}

export async function executeConfirmedAdminAction(database: Db, action: any, session: any): Promise<string> {
  const now = new Date();
  const payload = action.payload || {};

  if (action.type === "direct_upi_reconcile") {
    const pendingId = new ObjectId(String(payload.pending_id));
    const userId = new ObjectId(String(payload.user_id));
    const amountPaise = Number(payload.amount_paise);
    const amount = amountPaise / 100;
    const memo = String(payload.memo || "").trim().toUpperCase();
    const utr = String(payload.utr || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const transactionId = String(payload.transaction_id || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const reason = String(payload.reason || "").trim();
    if (reason.length < 5 || reason.length > 500) throw new Error("INVALID_REASON");
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new Error("INVALID_AMOUNT");
    if (!/^SUP[A-Z0-9]{5}$/.test(memo)) throw new Error("INVALID_MEMO");
    if (!/^\d{12}$/.test(utr) || !/^[A-Z0-9]{8,40}$/.test(transactionId)) throw new Error("INVALID_RECEIPT_IDENTIFIERS");

    const pending: any = await database.collection("transactions").findOne({
      _id: pendingId,
      user_id: userId,
      method: "FAMPAY_UPI",
      memo,
      status: { $in: ["pending", "expired"] },
    }, { session });
    if (!pending) throw new Error("PENDING_DEPOSIT_STALE");
    if (Math.round(Number(pending.amount) * 100) !== amountPaise) throw new Error("RECEIPT_AMOUNT_MISMATCH");

    const user: any = await database.collection("users").findOne({ _id: userId }, { session });
    if (!user) throw new Error("USER_NOT_FOUND");
    if (user.payment_hold === true) throw new Error("PAYMENT_HOLD_ACTIVE");
    const beforePaise = Math.round(Number(user.balance || 0) * 100);
    const settlementKey = `direct_upi:${pendingId.toString()}`;

    await database.collection("processed_transactions").insertOne({
      utr,
      transaction_id: transactionId,
      memo,
      amount,
      pending_transaction_id: pendingId,
      user_id: userId,
      user_email: pending.user_email || user.email,
      method: "OWNER_RECEIPT_RECONCILIATION",
      reason: reason,
      actor_telegram_id: action.actor_telegram_id,
      processed_at: now,
    }, { session });

    const claimed = await database.collection("transactions").updateOne(
      { _id: pendingId, status: pending.status },
      { $set: {
        status: "paid",
        direct_upi_settlement_key: settlementKey,
        utr,
        transaction_id: transactionId,
        verified_amount: amount,
        settled_by: "owner_receipt_reconciliation",
        reconciliation_reason: reason,
        reconciled_by: action.actor_telegram_id,
        paid_at: now,
      } },
      { session },
    );
    if (claimed.modifiedCount !== 1) throw new Error("PENDING_DEPOSIT_STALE");

    const updated: any = await database.collection("users").findOneAndUpdate(
      { _id: userId, payment_hold: { $ne: true } },
      { $inc: { balance: amount }, $set: { updated_at: now } },
      { returnDocument: "after", session },
    );
    if (!updated) throw new Error("PAYMENT_HOLD_ACTIVE");

    await database.collection("wallet_ledger").insertOne({
      settlement_key: settlementKey,
      user_id: userId,
      type: "credit",
      amount,
      amount_paise: amountPaise,
      currency: "INR",
      source: "direct_upi_owner_reconciliation",
      transaction_id: pendingId,
      reason: reason,
      actor_telegram_id: action.actor_telegram_id,
      before_balance_paise: beforePaise,
      after_balance_paise: Math.round(Number(updated.balance || 0) * 100),
      created_at: now,
    }, { session });
    await database.collection("security_events").insertOne({
      user_id: userId,
      type: "direct_upi_owner_reconciled",
      pending_transaction_id: pendingId,
      utr,
      transaction_id: transactionId,
      reason: reason,
      actor_telegram_id: action.actor_telegram_id,
      created_at: now,
    }, { session });
    await database.collection("payment_reconciliation").updateMany(
      { $or: [{ pending_transaction_id: pendingId }, { memo }], status: "open" },
      { $set: { status: "resolved", resolved_at: now, resolved_by: action.actor_telegram_id, resolution_reason: reason } },
      { session },
    );
    await appendAdminAudit(database, session, action, "completed", {
      pending_transaction_id: pendingId,
      amount_paise: amountPaise,
      utr,
      transaction_id: transactionId,
      reason: reason,
      before_balance_paise: beforePaise,
      after_balance_paise: Math.round(Number(updated.balance || 0) * 100),
    });
    return `✅ Reconciled Direct UPI <code>${escapeHtml(memo)}</code> and credited <b>₹${amount.toFixed(2)}</b> to <code>${escapeHtml(user.email)}</code>. New balance: <b>₹${Number(updated.balance || 0).toFixed(2)}</b>.`;
  }

  if (["wallet_credit", "wallet_debit"].includes(action.type)) {
    const userId = new ObjectId(String(payload.user_id));
    const amountPaise = Number(payload.amount_paise);
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new Error("INVALID_AMOUNT");
    const amount = amountPaise / 100;
    const user: any = await database.collection("users").findOne({ _id: userId }, { session });
    if (!user) throw new Error("USER_NOT_FOUND");
    const beforePaise = Math.round(Number(user.balance || 0) * 100);
    if (action.type === "wallet_debit" && beforePaise < amountPaise) throw new Error("INSUFFICIENT_BALANCE");
    const delta = action.type === "wallet_credit" ? amount : -amount;
    const updated: any = await database.collection("users").findOneAndUpdate(
      { _id: userId, ...(delta < 0 ? { balance: { $gte: amount } } : {}) },
      { $inc: { balance: delta }, $set: { updated_at: now } },
      { returnDocument: "after", session },
    );
    if (!updated) throw new Error("BALANCE_CHANGED");
    const settlementKey = `admin_wallet:${action._id.toString()}`;
    await database.collection("wallet_ledger").insertOne({
      settlement_key: settlementKey,
      type: action.type,
      user_id: userId,
      amount: delta,
      amount_paise: action.type === "wallet_credit" ? amountPaise : -amountPaise,
      currency: "INR",
      source: "telegram_bot",
      reason: payload.reason,
      actor_telegram_id: action.actor_telegram_id,
      before_balance_paise: beforePaise,
      after_balance_paise: Math.round(Number(updated.balance || 0) * 100),
      created_at: now,
    }, { session });
    await database.collection("transactions").insertOne({
      user_id: userId,
      user_email: user.email,
      amount: delta,
      type: action.type === "wallet_credit" ? "manual_credit" : "manual_debit",
      status: "completed",
      source: "telegram_bot",
      reason: payload.reason,
      wallet_settlement_key: settlementKey,
      actor_telegram_id: action.actor_telegram_id,
      created_at: now,
    }, { session });
    await appendAdminAudit(database, session, action, "completed", {
      amount_paise: amountPaise,
      before_balance_paise: beforePaise,
      after_balance_paise: Math.round(Number(updated.balance || 0) * 100),
      reason: payload.reason,
    });
    return `${action.type === "wallet_credit" ? "✅ Credited" : "🔻 Debited"} <b>₹${amount.toFixed(2)}</b> for <code>${escapeHtml(user.email)}</code>. New balance: <b>₹${Number(updated.balance || 0).toFixed(2)}</b>.`;
  }

  if (action.type === "order_refund") {
    const orderId = new ObjectId(String(payload.order_id));
    const order: any = await database.collection("orders").findOne({ _id: orderId }, { session });
    if (!order) throw new Error("ORDER_NOT_FOUND");
    if (order.refund_status === "refunded") throw new Error("ALREADY_REFUNDED");
    const refundAmount = Number(order.charge || 0);
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) throw new Error("INVALID_REFUND_AMOUNT");
    const refundPaise = Math.round(refundAmount * 100);
    const settlementKey = `order_refund:${order._id.toString()}`;
    await database.collection("wallet_ledger").insertOne({
      settlement_key: settlementKey,
      type: "api_order_refund",
      user_id: order.user_id,
      order_id: order._id,
      api_key_id: order.api_key_id || null,
      api_key_version: order.api_key_version || null,
      amount: refundAmount,
      amount_paise: refundPaise,
      currency: "INR",
      source: "telegram_bot",
      reason: payload.reason,
      actor_telegram_id: action.actor_telegram_id,
      created_at: now,
    }, { session });
    const changed = await database.collection("orders").updateOne(
      { _id: order._id, refund_status: { $ne: "refunded" } },
      { $set: { status: "Refunded", refund_status: "refunded", refunded_at: now, refunded_by: action.actor_telegram_id, refund_reason: payload.reason, updated_at: now } },
      { session },
    );
    if (changed.modifiedCount !== 1) throw new Error("ALREADY_REFUNDED");
    const user: any = await database.collection("users").findOneAndUpdate(
      { _id: order.user_id },
      [{ $set: {
        balance: { $add: [{ $ifNull: ["$balance", 0] }, refundAmount] },
        total_spent: { $max: [0, { $subtract: [{ $ifNull: ["$total_spent", 0] }, refundAmount] }] },
        total_orders: { $max: [0, { $subtract: [{ $ifNull: ["$total_orders", 0] }, 1] }] },
        updated_at: now,
      } }],
      { returnDocument: "after", session },
    );
    if (!user) throw new Error("USER_NOT_FOUND");
    await database.collection("transactions").insertOne({
      user_id: order.user_id, user_email: order.user_email, amount: refundAmount,
      type: "manual_refund", status: "completed", order_id: order._id,
      api_key_id: order.api_key_id || null, api_key_version: order.api_key_version || null,
      wallet_settlement_key: settlementKey, source: "telegram_bot", reason: payload.reason,
      actor_telegram_id: action.actor_telegram_id, created_at: now,
    }, { session });
    await appendAdminAudit(database, session, action, "completed", { order_id: orderId, amount_paise: refundPaise, reason: payload.reason });
    return `✅ Refunded order <code>${orderId.toString()}</code> by <b>₹${refundAmount.toFixed(2)}</b>. New balance: <b>₹${Number(user.balance || 0).toFixed(2)}</b>.`;
  }

  if (["account_lock", "account_unlock", "ordering_hold", "ordering_release", "payment_hold", "payment_release"].includes(action.type)) {
    const userId = new ObjectId(String(payload.user_id));
    const fieldMap: Record<string, [string, boolean]> = {
      account_lock: ["account_locked", true], account_unlock: ["account_locked", false],
      ordering_hold: ["ordering_hold", true], ordering_release: ["ordering_hold", false],
      payment_hold: ["payment_hold", true], payment_release: ["payment_hold", false],
    };
    const [field, value] = fieldMap[action.type];
    const update: any = { [field]: value, [`${field}_reason`]: payload.reason, [`${field}_at`]: now, updated_at: now };
    if (!value) update[`${field}_cleared_at`] = now;
    const user: any = await database.collection("users").findOneAndUpdate(
      { _id: userId }, { $set: update }, { returnDocument: "after", session },
    );
    if (!user) throw new Error("USER_NOT_FOUND");
    if (action.type === "account_lock") {
      await database.collection("sessions").updateMany(
        { $or: [{ user_id: userId }, { actor_admin_id: userId }], revoked_at: null },
        { $set: { revoked_at: now, revoked_reason: "account_locked_by_owner" } }, { session },
      );
      await database.collection("restricted_sessions").updateMany(
        { user_id: userId, invalidated_at: null },
        { $set: { invalidated_at: now, invalidation_reason: "account_locked_by_owner" } }, { session },
      );
      await database.collection("users").updateOne({ _id: userId }, { $set: { sessions_revoked_before: now } }, { session });
    }
    await database.collection("security_events").insertOne({
      user_id: userId, type: action.type, reason: payload.reason,
      actor_telegram_id: action.actor_telegram_id, created_at: now,
    }, { session });
    await appendAdminAudit(database, session, action, "completed", { reason: payload.reason, value });
    return `✅ <b>${action.type.replace(/_/g, " ")}</b> applied to <code>${escapeHtml(user.email)}</code>.`;
  }

  if (["api_pause", "api_resume", "api_archive", "api_reissue_required"].includes(action.type)) {
    const keyId = new ObjectId(String(payload.key_id));
    const key: any = await database.collection("api_keys").findOne({ _id: keyId }, { session });
    if (!key) throw new Error("API_KEY_NOT_FOUND");
    if (action.type === "api_resume" && key.owner_reissue_required === true) throw new Error("API_REISSUE_PENDING");
    const nextStatus = action.type === "api_resume" ? "active" : action.type === "api_archive" ? "archived" : "paused";
    const set: any = { status: nextStatus, updated_at: now, owner_action_reason: payload.reason };
    if (action.type === "api_archive") {
      set.archived_at = now; set.active_name_normalized = null;
    }
    if (action.type === "api_reissue_required") set.owner_reissue_required = true;
    await database.collection("api_keys").updateOne({ _id: keyId }, { $set: set }, { session });
    if (["api_archive", "api_reissue_required"].includes(action.type)) {
      await database.collection("api_key_versions").updateMany(
        { key_id: keyId, revoked_at: null },
        { $set: { revoked_at: now, revoked_reason: action.type } }, { session },
      );
    }
    await database.collection("api_key_audit").insertOne({
      user_id: key.user_id, api_key_id: keyId, event: action.type, reason: payload.reason,
      actor_telegram_id: action.actor_telegram_id, created_at: now,
    }, { session });
    await appendAdminAudit(database, session, action, "completed", { key_id: keyId, reason: payload.reason });
    return `✅ API key <b>${escapeHtml(key.name)}</b>: ${action.type.replace("api_", "").replace(/_/g, " ")}.`;
  }

  throw new Error("UNSUPPORTED_ADMIN_ACTION");
}
