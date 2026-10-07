import { ImapFlow } from "imapflow";
import type { Telegraf } from "telegraf";
import { OWNER_ID } from "../config.js";
import { getDatabase, getMongoClient } from "../db/client.js";
import { escapeHtml } from "../security/telegramHtml.js";
import { settleImapPendingPayment } from "./settlement.js";

export function createPaymentScanner(bot: Telegraf<any>) {
  function decodeQuotedPrintable(str: string): string {
    return str
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }


  async function scanAndSettlePayments(): Promise<string> {
    const imapUser = process.env.IMAP_USER || "";
    const imapPass = process.env.IMAP_PASSWORD || "";
    const senderFilter = String(process.env.FAMPAY_SENDER_FILTER || "no-reply@famapp.in").trim().toLowerCase();

    if (!imapUser || !imapPass) {
      return "⚠️ IMAP credentials (IMAP_USER, IMAP_PASSWORD) are not set. Worker is dormant.";
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(senderFilter)) {
      return "⚠️ FAMPAY_SENDER_FILTER must be one exact email address. Worker is dormant.";
    }

    const database = await getDatabase();
    const client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: { user: imapUser, pass: imapPass },
      logger: false,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10_000,
    });

    let settledCount = 0;
    let matchesChecked = 0;

    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");

      try {
        // Find emails received in the last 2 days from the sender
        const sinceDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
        const searchResults = await client.search({
          from: senderFilter,
          since: sinceDate,
        });

        if (!searchResults || searchResults.length === 0) {
          return "ℹ️ IMAP scan completed. No recent FamPay emails found in the last 48 hours.";
        }

        // Fetch the latest 30 matching emails
        const targetIds = searchResults.slice(-30);

        for await (const message of client.fetch(targetIds, {
          envelope: true,
          source: true,
          internalDate: true,
        })) {
          matchesChecked++;
          const envelopeSenders = (message.envelope?.from || [])
            .map((entry) => String(entry.address || "").trim().toLowerCase())
            .filter(Boolean);
          if (envelopeSenders.length !== 1 || envelopeSenders[0] !== senderFilter) continue;
          const messageDate = new Date(message.internalDate || message.envelope?.date || 0);
          if (!Number.isFinite(messageDate.getTime()) || messageDate.getTime() > Date.now() + 5 * 60_000) continue;

          const rawContent = message.source ? message.source.toString("utf8") : "";
          const decodedText = decodeQuotedPrintable(rawContent);

          // 1. Extract Memo (SUP + 5 alphanumeric characters)
          const memoMatch = decodedText.match(/\b(SUP[A-Z0-9]{5})\b/i);
          const memo = memoMatch ? memoMatch[1].toUpperCase() : null;

          // 2. Extract UTR (12 digits)
          const utrMatch = decodedText.match(/(?:UTR|Ref|rrn|upi\s*ref(?:erence)?\s*(?:no|number)?)\s*[:#-]?\s*(\d{12})\b/i);
          const utr = utrMatch ? utrMatch[1] : null;

          // 3. Extract FamPay TxID
          const txMatch = decodedText.match(/\b(FMPIB[A-Z0-9]+)\b/i);
          const txId = txMatch ? txMatch[1] : null;

          // 4. Extract Amount
          const amountMatch = decodedText.match(/(?:received|credited|deposit(?:ed)?|paid)\s*(?:of)?\s*(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i)
            || (message.envelope.subject ? message.envelope.subject.match(/(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i) : null);
          const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, "")) : 0;

          // If we found a memo, try to auto-settle the pending transaction
          if (memo) {
            // Check if already processed
            const alreadyProcessed = await database.collection("processed_transactions").findOne({
              $or: [
                { memo: memo },
                ...(utr ? [{ utr: utr }] : []),
                ...(txId ? [{ transaction_id: txId }] : []),
              ],
            });

            if (!alreadyProcessed) {
              // Find matching pending transaction in MongoDB
              const pendingTxn = await database.collection("transactions").findOne({
                memo,
                method: "FAMPAY_UPI",
                status: "pending",
                expires_at: { $gt: new Date() },
              });

              if (pendingTxn) {
                const pendingCreatedAt = new Date(pendingTxn.created_at).getTime();
                if (!Number.isFinite(pendingCreatedAt) || messageDate.getTime() < pendingCreatedAt - 2 * 60_000) {
                  continue;
                }
                if (!amount || Math.round(amount * 100) !== Math.round(Number(pendingTxn.amount) * 100)) {
                  const issue = await database.collection("payment_reconciliation").updateOne(
                    { memo, status: "open", reason: "amount_missing_or_mismatch" },
                    {
                      $set: {
                        pending_transaction_id: pendingTxn._id,
                        user_id: pendingTxn.user_id,
                        expected_amount: Number(pendingTxn.amount),
                        observed_amount: amount || null,
                        last_seen_at: new Date(),
                      },
                      $inc: { attempts: 1 },
                      $setOnInsert: { created_at: new Date(), status: "open" },
                    },
                    { upsert: true },
                  );
                  if (issue.upsertedCount && OWNER_ID) {
                    await bot.telegram.sendMessage(
                      OWNER_ID,
                      `⚠️ <b>Direct UPI reconciliation required</b>\nMemo: <code>${memo}</code>\nExpected: ₹${Number(pendingTxn.amount).toFixed(2)}\nObserved: ${amount ? `₹${amount.toFixed(2)}` : "not parsed"}`,
                      { parse_mode: "HTML" },
                    ).catch(console.error);
                  }
                  continue;
                }

                const mongoClient = getMongoClient();
                if (!mongoClient) throw new Error("Database client unavailable for settlement transaction");
                try {
                  const result = await settleImapPendingPayment(database, mongoClient, {
                    pendingId: pendingTxn._id,
                    userId: pendingTxn.user_id,
                    userEmail: pendingTxn.user_email,
                    memo,
                    amount,
                    utr,
                    transactionId: txId,
                  });
                  settledCount++;
                  await database.collection("payment_reconciliation").updateMany(
                    { memo, status: "open" },
                    { $set: { status: "resolved", resolved_at: new Date() } },
                  );

                  if (OWNER_ID) {
                    const alertMsg = `
  🎉 <b>[AUTOMATIC ZERO-CLICK SETTLEMENT]</b> 🎉
  User: <code>${escapeHtml(pendingTxn.user_email)}</code>
  Credited: <b>₹${amount.toFixed(2)}</b>
  New Balance: <b>₹${result.newBalance.toFixed(2)}</b>
  Memo: <code>${memo}</code>
  UTR: <code>${utr || "N/A"}</code>
  TxID: <code>${txId || "N/A"}</code>
  Time: <code>${new Date().toLocaleTimeString("en-IN")}</code>
  `;
                    await bot.telegram.sendMessage(OWNER_ID, alertMsg, { parse_mode: "HTML" }).catch(console.error);
                  }
                } catch (error: any) {
                  if (error?.code !== 11000 && error?.message !== "PENDING_DEPOSIT_STALE") {
                    await database.collection("payment_reconciliation").updateOne(
                      { memo, status: "open", reason: error?.message === "PAYMENT_HOLD_ACTIVE" ? "payment_hold" : "settlement_error" },
                      {
                        $set: {
                          pending_transaction_id: pendingTxn._id,
                          user_id: pendingTxn.user_id,
                          last_error: String(error?.message || error).slice(0, 500),
                          last_seen_at: new Date(),
                        },
                        $inc: { attempts: 1 },
                        $setOnInsert: { created_at: new Date(), status: "open" },
                      },
                      { upsert: true },
                    );
                    throw error;
                  }
                }
              }
            }
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }

    return `✅ IMAP scan finished. Checked ${matchesChecked} emails. Auto-settled ${settledCount} pending deposits.`;
  }

  return { scanAndSettlePayments };
}
