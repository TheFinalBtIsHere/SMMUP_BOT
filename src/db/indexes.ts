import type { Db } from "mongodb";

const processedTransactionIdentifierIndexes = [
  { field: "utr", name: "processed_transactions_utr_unique_sparse" },
  { field: "transaction_id", name: "processed_transactions_transaction_id_unique_sparse" },
  { field: "memo", name: "processed_transactions_memo_unique_sparse" },
] as const;

async function ensureProcessedTransactionIdentifierIndexes(database: Db) {
  const collection = database.collection("processed_transactions");
  let existingIndexes: any[] = [];

  try {
    existingIndexes = await collection.listIndexes().toArray();
  } catch (error: any) {
    // listIndexes returns NamespaceNotFound before this collection has been created.
    if (error?.code !== 26 && error?.codeName !== "NamespaceNotFound") throw error;
  }

  const indexesToCreate = processedTransactionIdentifierIndexes.filter(({ field }) => {
    return !existingIndexes.some((index) => {
      const keyEntries = Object.entries(index.key || {});
      return index.unique === true
        && !index.partialFilterExpression
        && keyEntries.length === 1
        && keyEntries[0][0] === field
        && keyEntries[0][1] === 1;
    });
  });

  await Promise.all(indexesToCreate.map(({ field, name }) =>
    collection.createIndex({ [field]: 1 }, { name, unique: true, sparse: true }),
  ));
}

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
    ensureProcessedTransactionIdentifierIndexes(database),
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
