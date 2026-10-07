import type { Db } from "mongodb";

export async function ensureAdminControlIndexes(database: Db) {
  await Promise.all([
    database.collection("admin_pending_actions").createIndex({ token_hash: 1 }, { unique: true }),
    database.collection("admin_pending_actions").createIndex({ expires_at: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 }),
    database.collection("admin_pending_actions").createIndex({ actor_telegram_id: 1, created_at: -1 }),
    database.collection("admin_action_tokens").createIndex({ token_hash: 1 }, { unique: true }),
    database.collection("admin_action_tokens").createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    database.collection("admin_audit").createIndex({ created_at: -1 }),
    database.collection("admin_audit").createIndex({ subject_user_id: 1, created_at: -1 }),
    database.collection("admin_notes").createIndex({ user_id: 1, created_at: -1 }),
    database.collection("security_events").createIndex({ user_id: 1, created_at: -1 }),
    database.collection("payment_reconciliation").createIndex(
      { memo: 1, status: 1, reason: 1 },
      { unique: true, partialFilterExpression: { status: "open" } },
    ),
    database.collection("processed_transactions").createIndex({ utr: 1 }, { unique: true, sparse: true }),
    database.collection("processed_transactions").createIndex({ transaction_id: 1 }, { unique: true, sparse: true }),
    database.collection("processed_transactions").createIndex({ memo: 1 }, { unique: true, sparse: true }),
    database.collection("transactions").createIndex(
      { memo: 1 },
      {
        name: "transactions_memo_unique_v2",
        unique: true,
        partialFilterExpression: { memo: { $type: "string" } },
      },
    ),
    database.collection("transactions").createIndex(
      { direct_upi_settlement_key: 1 },
      { unique: true, partialFilterExpression: { direct_upi_settlement_key: { $type: "string" } } },
    ),
    database.collection("wallet_ledger").createIndex(
      { settlement_key: 1 },
      { unique: true, partialFilterExpression: { settlement_key: { $type: "string" } } },
    ),
  ]);
}
