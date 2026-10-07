import assert from "node:assert/strict";
import crypto from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { MongoClient, ObjectId } from "mongodb";

async function run() {
  const repl = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  let client: MongoClient | null = null;
  try {
    process.env.ADMIN_BOT_DISABLE_AUTOSTART = "true";
    process.env.TELEGRAM_BOT_TOKEN = "0:test-token";
    process.env.TELEGRAM_OWNER_ID = "123456";
    process.env.MONGODB_URI = repl.getUri();
    process.env.MONGODB_DB_NAME = "admin_actions_integration";
    const actions = await import("../bot.js");
    client = new MongoClient(repl.getUri());
    await client.connect();
    const db = client.db("admin_actions_integration");
    await actions.ensureAdminControlIndexes(db);
    const freshProcessedIndexes = await db.collection("processed_transactions").listIndexes().toArray();
    for (const field of ["utr", "transaction_id", "memo"]) {
      assert.ok(freshProcessedIndexes.some((index) => index.name === `processed_transactions_${field}_unique_sparse` && index.unique && index.sparse));
    }

    // Existing website/legacy databases may already have auto-named, non-sparse unique indexes.
    const legacyDb = client.db("legacy_index_compatibility");
    const legacyProcessed = legacyDb.collection("processed_transactions");
    await Promise.all([
      legacyProcessed.createIndex({ utr: 1 }, { unique: true }),
      legacyProcessed.createIndex({ transaction_id: 1 }, { unique: true }),
      legacyProcessed.createIndex({ memo: 1 }, { unique: true }),
    ]);
    await actions.ensureAdminControlIndexes(legacyDb);
    const legacyIndexes = await legacyProcessed.listIndexes().toArray();
    for (const field of ["utr", "transaction_id", "memo"]) {
      assert.ok(legacyIndexes.some((index) => index.name === `${field}_1` && index.unique), `legacy ${field} unique index should be retained`);
    }

    const legacyUserId = new ObjectId();
    await legacyDb.collection("users").insertOne({ _id: legacyUserId, email: "legacy@example.com", balance: 0 });
    for (const memo of ["SUPNOID1", "SUPNOID2"]) {
      const pendingId = new ObjectId();
      await legacyDb.collection("transactions").insertOne({
        _id: pendingId, user_id: legacyUserId, user_email: "legacy@example.com",
        method: "FAMPAY_UPI", amount: 10, memo, status: "pending",
        expires_at: new Date(Date.now() + 60_000),
      });
      await actions.settleImapPendingPayment(legacyDb, client, {
        pendingId, userId: legacyUserId, userEmail: "legacy@example.com", memo, amount: 10,
      });
    }
    const legacySettlements = await legacyProcessed.find({ source: "railway_imap_worker", utr_missing: true, transaction_id_missing: true }).toArray();
    assert.equal(legacySettlements.length, 2, "multiple no-identifier receipts must coexist with legacy non-sparse indexes");
    assert.notEqual(legacySettlements[0].utr, legacySettlements[1].utr);
    assert.notEqual(legacySettlements[0].transaction_id, legacySettlements[1].transaction_id);
    assert.equal((await legacyDb.collection("users").findOne({ _id: legacyUserId }))?.balance, 20);

    const userId = new ObjectId();
    const keyId = new ObjectId();
    const orderId = new ObjectId();
    const now = new Date();
    await db.collection("users").insertOne({ _id: userId, email: "admin-target@example.com", username: "target", balance: 100, total_spent: 25, total_orders: 1 });
    await db.collection("api_keys").insertOne({ _id: keyId, user_id: userId, name: "Production", public_id: "smup_test", status: "active", current_version: 1, scopes: ["orders:create"], created_at: now });
    await db.collection("api_key_versions").insertOne({ key_id: keyId, user_id: userId, version: 1, status: "current", secret_hash: crypto.randomBytes(32).toString("hex"), revoked_at: null });
    await db.collection("orders").insertOne({ _id: orderId, user_id: userId, user_email: "admin-target@example.com", charge: 25, status: "Failed", refund_status: "requires_admin_review", api_key_id: keyId, api_key_version: 1 });

    async function execute(type: string, payload: any, id = new ObjectId()) {
      const session = client!.startSession();
      let text = "";
      try {
        await session.withTransaction(async () => {
          text = await actions.executeConfirmedAdminAction(db, {
            _id: id, type, payload, actor_telegram_id: "123456", actor_username: "owner",
          }, session);
        });
      } finally {
        await session.endSession();
      }
      return { id, text };
    }

    const credit = await execute("wallet_credit", { user_id: userId.toString(), amount_paise: 5050, reason: "Verified wallet correction" });
    assert.match(credit.text, /Credited/);
    assert.equal((await db.collection("users").findOne({ _id: userId }))?.balance, 150.5);
    assert.equal(await db.collection("wallet_ledger").countDocuments({ settlement_key: `admin_wallet:${credit.id}` }), 1);
    await assert.rejects(() => execute("wallet_credit", { user_id: userId.toString(), amount_paise: 5050, reason: "Duplicate" }, credit.id));
    assert.equal((await db.collection("users").findOne({ _id: userId }))?.balance, 150.5, "duplicate action must roll back");

    await assert.rejects(() => execute("wallet_debit", { user_id: userId.toString(), amount_paise: 999_999, reason: "Must fail" }));
    assert.equal((await db.collection("users").findOne({ _id: userId }))?.balance, 150.5);

    await execute("ordering_hold", { user_id: userId.toString(), reason: "Risk review" });
    assert.equal((await db.collection("users").findOne({ _id: userId }))?.ordering_hold, true);
    await execute("account_lock", { user_id: userId.toString(), reason: "Compromise report" });
    assert.equal((await db.collection("users").findOne({ _id: userId }))?.account_locked, true);

    await execute("api_pause", { key_id: keyId.toString(), user_id: userId.toString(), reason: "Temporary pause" });
    assert.equal((await db.collection("api_keys").findOne({ _id: keyId }))?.status, "paused");
    assert.equal((await db.collection("api_key_versions").findOne({ key_id: keyId }))?.revoked_at, null, "pause must preserve the secret for resume");
    await execute("api_reissue_required", { key_id: keyId.toString(), user_id: userId.toString(), reason: "Compromised secret" });
    assert.equal((await db.collection("api_keys").findOne({ _id: keyId }))?.owner_reissue_required, true);
    assert.ok((await db.collection("api_key_versions").findOne({ key_id: keyId }))?.revoked_at instanceof Date);

    const refund = await execute("order_refund", { order_id: orderId.toString(), reason: "Provider failure reviewed" });
    assert.match(refund.text, /Refunded/);
    assert.equal((await db.collection("orders").findOne({ _id: orderId }))?.refund_status, "refunded");
    assert.equal((await db.collection("users").findOne({ _id: userId }))?.balance, 175.5);
    await assert.rejects(() => execute("order_refund", { order_id: orderId.toString(), reason: "Duplicate refund" }));
    assert.equal((await db.collection("users").findOne({ _id: userId }))?.balance, 175.5);

    const reconciliationPendingId = new ObjectId();
    await db.collection("transactions").insertOne({
      _id: reconciliationPendingId, user_id: userId, user_email: "admin-target@example.com",
      method: "FAMPAY_UPI", amount: 50, memo: "SUPRECN1", status: "expired",
      expires_at: new Date(Date.now() - 60_000), created_at: new Date(Date.now() - 10 * 60_000),
    });
    await assert.rejects(() => execute("direct_upi_reconcile", {
      pending_id: reconciliationPendingId.toString(), user_id: userId.toString(), amount_paise: 5000,
      memo: "SUPRECN1", utr: "223456789012", transaction_id: "FMPIBRECON1", reason: "x",
    }), /INVALID_REASON/);
    assert.equal((await db.collection("transactions").findOne({ _id: reconciliationPendingId }))?.status, "expired");
    assert.equal((await db.collection("users").findOne({ _id: userId }))?.balance, 175.5);
    const reconciled = await execute("direct_upi_reconcile", {
      pending_id: reconciliationPendingId.toString(), user_id: userId.toString(), amount_paise: 5000,
      memo: "SUPRECN1", utr: "223456789012", transaction_id: "FMPIBRECON1",
      reason: "Trusted FamApp receipt checked; provider removed the SUP note",
    });
    assert.match(reconciled.text, /Reconciled Direct UPI/);
    assert.equal((await db.collection("transactions").findOne({ _id: reconciliationPendingId }))?.status, "paid");
    assert.equal((await db.collection("users").findOne({ _id: userId }))?.balance, 225.5);
    assert.equal(await db.collection("processed_transactions").countDocuments({ utr: "223456789012" }), 1);
    await assert.rejects(() => execute("direct_upi_reconcile", {
      pending_id: reconciliationPendingId.toString(), user_id: userId.toString(), amount_paise: 5000,
      memo: "SUPRECN1", utr: "223456789012", transaction_id: "FMPIBRECON1", reason: "Replay",
    }));
    assert.equal((await db.collection("users").findOne({ _id: userId }))?.balance, 225.5, "owner reconciliation replay must not double-credit");

    const pendingId = new ObjectId();
    await db.collection("transactions").insertOne({
      _id: pendingId, user_id: userId, user_email: "admin-target@example.com",
      method: "FAMPAY_UPI", amount: 40, memo: "SUPTEST1", status: "pending",
      expires_at: new Date(Date.now() + 60_000), created_at: new Date(),
    });
    const workerInput = {
      pendingId, userId, userEmail: "admin-target@example.com", memo: "SUPTEST1",
      amount: 40, utr: "123456789012", transactionId: "FMPIBWORKER1",
    };
    const workerRace = await Promise.allSettled([
      actions.settleImapPendingPayment(db, client, workerInput),
      actions.settleImapPendingPayment(db, client, workerInput),
    ]);
    assert.equal(workerRace.filter((item) => item.status === "fulfilled").length, 1, "worker settlement must commit once");
    assert.equal((await db.collection("users").findOne({ _id: userId }))?.balance, 265.5);
    assert.equal(await db.collection("wallet_ledger").countDocuments({ transaction_id: pendingId }), 1);
    assert.equal(await db.collection("processed_transactions").countDocuments({ pending_transaction_id: pendingId }), 1);

    const heldPendingId = new ObjectId();
    await db.collection("users").updateOne({ _id: userId }, { $set: { payment_hold: true } });
    await db.collection("transactions").insertOne({
      _id: heldPendingId, user_id: userId, user_email: "admin-target@example.com",
      method: "FAMPAY_UPI", amount: 20, memo: "SUPHELD1", status: "pending",
      expires_at: new Date(Date.now() + 60_000), created_at: new Date(),
    });
    await assert.rejects(() => actions.settleImapPendingPayment(db, client!, {
      pendingId: heldPendingId, userId, userEmail: "admin-target@example.com", memo: "SUPHELD1",
      amount: 20, utr: "123456789013", transactionId: "FMPIBWORKER2",
    }), /PAYMENT_HOLD_ACTIVE/);
    assert.equal((await db.collection("transactions").findOne({ _id: heldPendingId }))?.status, "pending");
    assert.equal((await db.collection("users").findOne({ _id: userId }))?.balance, 265.5);

    const heldReconciliationId = new ObjectId();
    await db.collection("transactions").insertOne({
      _id: heldReconciliationId, user_id: userId, user_email: "admin-target@example.com",
      method: "FAMPAY_UPI", amount: 30, memo: "SUPHLD02", status: "expired",
      expires_at: new Date(Date.now() - 60_000), created_at: new Date(Date.now() - 10 * 60_000),
    });
    await assert.rejects(() => execute("direct_upi_reconcile", {
      pending_id: heldReconciliationId.toString(), user_id: userId.toString(), amount_paise: 3000,
      memo: "SUPHLD02", utr: "323456789012", transaction_id: "FMPIBRECON2",
      reason: "Trusted receipt checked while account payment hold remains active",
    }), /PAYMENT_HOLD_ACTIVE/);
    assert.equal((await db.collection("transactions").findOne({ _id: heldReconciliationId }))?.status, "expired");
    assert.equal(await db.collection("processed_transactions").countDocuments({ utr: "323456789012" }), 0);
    assert.equal((await db.collection("users").findOne({ _id: userId }))?.balance, 265.5);

    assert.ok(await db.collection("admin_audit").countDocuments() >= 6);
    console.log("Telegram administrative action integration checks passed.");
  } finally {
    await client?.close().catch(() => {});
    await repl.stop();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
