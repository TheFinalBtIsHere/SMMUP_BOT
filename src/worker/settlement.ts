import { ObjectId, type Db, type MongoClient } from "mongodb";

export async function settleImapPendingPayment(
  database: Db,
  client: MongoClient,
  input: {
    pendingId: ObjectId;
    userId: ObjectId;
    userEmail: string;
    memo: string;
    amount: number;
    utr?: string | null;
    transactionId?: string | null;
  },
): Promise<{ newBalance: number }> {
  const memo = String(input.memo || "").trim().toUpperCase();
  if (!memo || !Number.isFinite(input.amount) || input.amount <= 0) throw new Error("RECEIPT_INVALID");
  const settlementKey = `direct_upi:${input.pendingId.toString()}`;
  const session = client.startSession();
  let newBalance = 0;
  try {
    await session.withTransaction(async () => {
      const current: any = await database.collection("transactions").findOne({
        _id: input.pendingId,
        user_id: input.userId,
        method: "FAMPAY_UPI",
        memo,
        amount: input.amount,
        status: "pending",
        expires_at: { $gt: new Date() },
      }, { session });
      if (!current) throw new Error("PENDING_DEPOSIT_STALE");

      await database.collection("processed_transactions").insertOne({
        memo,
        ...(input.utr ? { utr: input.utr } : {}),
        ...(input.transactionId ? { transaction_id: input.transactionId } : {}),
        amount: input.amount,
        pending_transaction_id: input.pendingId,
        user_id: input.userId,
        user_email: input.userEmail,
        processed_at: new Date(),
        source: "railway_imap_worker",
      }, { session });

      const transactionUpdate = await database.collection("transactions").updateOne(
        { _id: input.pendingId, status: "pending" },
        {
          $set: {
            status: "paid",
            direct_upi_settlement_key: settlementKey,
            paid_at: new Date(),
            ...(input.utr ? { utr: input.utr } : {}),
            ...(input.transactionId ? { transaction_id: input.transactionId } : {}),
            verified_amount: input.amount,
            settled_by: "railway_imap_worker",
          },
        },
        { session },
      );
      if (transactionUpdate.modifiedCount !== 1) throw new Error("PENDING_DEPOSIT_STALE");

      const userUpdate: any = await database.collection("users").findOneAndUpdate(
        { _id: input.userId, payment_hold: { $ne: true } },
        { $inc: { balance: input.amount }, $set: { updated_at: new Date() } },
        { returnDocument: "after", session },
      );
      if (!userUpdate) throw new Error("PAYMENT_HOLD_ACTIVE");
      newBalance = Number(userUpdate.balance || 0);

      await database.collection("wallet_ledger").insertOne({
        settlement_key: settlementKey,
        user_id: input.userId,
        type: "credit",
        amount: input.amount,
        balance_after: newBalance,
        source: "direct_upi",
        transaction_id: input.pendingId,
        created_at: new Date(),
      }, { session });
      await database.collection("security_events").insertOne({
        user_id: input.userId,
        type: "direct_upi_worker_verified",
        pending_transaction_id: input.pendingId,
        created_at: new Date(),
      }, { session });
    }, {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    });
    return { newBalance };
  } finally {
    await session.endSession();
  }
}
