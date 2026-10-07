import { ObjectId } from "mongodb";
import type { Telegraf } from "telegraf";
import { temporaryPasswordMaxUses, temporaryPasswordTtlMinutes } from "../config.js";
import { getDatabase, getMongoClient } from "../db/client.js";
import { ensureAdminControlIndexes } from "../db/indexes.js";
import { createPasswordResetAction, issueSupportAccessCode, protectCustomTemporaryPassword, validateCustomTemporaryPassword } from "../domain/recoveryActions.js";
import { queueAdminAction } from "../domain/pendingActions.js";
import { escapeHtml } from "../security/telegramHtml.js";
import { addNavigation, button, homeKeyboard, pageNavigation, wizardKeyboard } from "../ui/adminDashboard.js";

const PAGE_SIZE = 5;
const MAX_PAGE = 9_999;
const FLOW_TTL_MS = 10 * 60_000;
const MAX_FLOWS = 200;
const MAX_ADMIN_AMOUNT_PAISE = 100_000_000_00;

type MoneyAction = "wallet_credit" | "wallet_debit";
type ControlAction = "account_lock" | "account_unlock" | "ordering_hold" | "ordering_release" | "payment_hold" | "payment_release";
type KeyAction = "api_pause" | "api_resume" | "api_archive" | "api_reissue_required";
type RecordKind = "orders" | "deposits" | "wallet" | "events" | "notes";
type OrderMode = "recent" | "failed";

type WizardFlow =
  | { kind: "user_search" }
  | { kind: "memo_search" }
  | { kind: "money"; userId: string; action: MoneyAction; step: "amount" | "reason"; amountPaise?: number }
  | { kind: "control"; userId: string; action: ControlAction }
  | { kind: "key"; keyId: string; action: KeyAction }
  | { kind: "refund"; orderId: string }
  | { kind: "note"; userId: string }
  | { kind: "support"; userId: string }
  | { kind: "reset_password"; userId: string; mode: "generated" | "owner_selected"; step: "password" | "reason"; protectedPassword?: { passwordHash: string; passwordEncrypted: { ciphertext: string; iv: string; tag: string } } }
  | { kind: "settleupi"; step: "memo" | "amount" | "utr" | "txid" | "reason"; memo?: string; pendingId?: string; userId?: string; userEmail?: string; expectedAmountPaise?: number; amountPaise?: number; utr?: string; transactionId?: string };

type WizardEntry = { flow: WizardFlow; expiresAt: number; timer?: ReturnType<typeof setTimeout> };
const activeFlows = new Map<string, WizardEntry>();

function armFlowExpiry(key: string, entry: WizardEntry) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    if (activeFlows.get(key) === entry && entry.expiresAt <= Date.now()) activeFlows.delete(key);
  }, Math.max(1, entry.expiresAt - Date.now()));
  entry.timer.unref?.();
}

function flowKey(ctx: any): string {
  return `${String(ctx.from?.id || "")}:${String(ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id || "")}`;
}

function pruneFlows() {
  const now = Date.now();
  for (const [key, entry] of activeFlows) {
    if (entry.expiresAt <= now) {
      if (entry.timer) clearTimeout(entry.timer);
      activeFlows.delete(key);
    }
  }
  while (activeFlows.size > MAX_FLOWS) {
    const first = activeFlows.keys().next().value;
    if (first === undefined) break;
    const entry = activeFlows.get(first);
    if (entry?.timer) clearTimeout(entry.timer);
    activeFlows.delete(first);
  }
}

function setFlow(ctx: any, flow: WizardFlow) {
  pruneFlows();
  const key = flowKey(ctx);
  const previous = activeFlows.get(key);
  if (previous?.timer) clearTimeout(previous.timer);
  const entry: WizardEntry = { flow, expiresAt: Date.now() + FLOW_TTL_MS };
  activeFlows.set(key, entry);
  armFlowExpiry(key, entry);
  pruneFlows();
}

function getFlow(ctx: any): WizardEntry | null {
  pruneFlows();
  const key = flowKey(ctx);
  const entry = activeFlows.get(key);
  if (!entry) return null;
  entry.expiresAt = Date.now() + FLOW_TTL_MS;
  armFlowExpiry(key, entry);
  return entry;
}

function clearFlow(ctx: any) {
  const key = flowKey(ctx);
  const entry = activeFlows.get(key);
  if (entry?.timer) clearTimeout(entry.timer);
  activeFlows.delete(key);
}

function toPage(raw: string | undefined): number {
  const parsed = Number.parseInt(raw || "0", 10);
  return Number.isSafeInteger(parsed) ? Math.max(0, Math.min(MAX_PAGE, parsed)) : 0;
}

function fmtMoney(value: unknown): string {
  const amount = Number(value || 0);
  return `₹${(Number.isFinite(amount) ? amount : 0).toFixed(2)}`;
}

function fmtDate(value: unknown): string {
  if (!value) return "—";
  const date = new Date(value as any);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) + " IST";
}

function idString(value: any): string {
  return value?.toString?.() || "";
}

function shortId(value: any): string {
  const id = idString(value);
  return id ? id.slice(-8) : "unknown";
}

function isObjectId(value: string | undefined): value is string {
  return Boolean(value && ObjectId.isValid(value));
}

function isEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function parseAmountPaise(value: string): number | null {
  const input = value.trim().replace(/^₹/, "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(input)) return null;
  const paise = Math.round(Number(input) * 100);
  return Number.isSafeInteger(paise) && paise > 0 && paise <= MAX_ADMIN_AMOUNT_PAISE ? paise : null;
}

async function render(ctx: any, text: string, replyMarkup: any) {
  const options: any = { parse_mode: "HTML", reply_markup: replyMarkup };
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch (error: any) {
      if (/message is not modified/i.test(String(error?.description || error?.message || ""))) return;
    }
  }
  await ctx.reply(text, options);
}

async function ask(ctx: any, prompt: string) {
  await ctx.reply(prompt, { parse_mode: "HTML", reply_markup: wizardKeyboard() });
}

async function beginFlow(ctx: any, flow: WizardFlow, prompt: string) {
  setFlow(ctx, flow);
  await ask(ctx, prompt);
}

async function getUserById(database: any, rawId: string): Promise<any | null> {
  if (!isObjectId(rawId)) return null;
  return database.collection("users").findOne({ _id: new ObjectId(rawId) });
}

async function renderHome(ctx: any) {
  await render(
    ctx,
    "<b>⚡ SMM UP Owner Console</b>\nChoose a workspace. All sensitive actions still require a reason and a separate confirmation.",
    homeKeyboard(),
  );
}

async function renderOverview(ctx: any) {
  const database = await getDatabase();
  const [users, orders, paid, pending, openIssues, balanceAgg, health] = await Promise.all([
    database.collection("users").countDocuments(),
    database.collection("orders").countDocuments(),
    database.collection("transactions").countDocuments({ status: "paid" }),
    database.collection("transactions").countDocuments({ status: "pending" }),
    database.collection("payment_reconciliation").countDocuments({ status: "open" }),
    database.collection("users").aggregate([{ $group: { _id: null, totalBalance: { $sum: "$balance" }, totalSpent: { $sum: "$total_spent" } } }]).toArray(),
    database.collection<any>("system_health").findOne({ _id: "imap_settlement_worker" }),
  ]);
  const totals = balanceAgg[0] || {};
  const rows = [
    [button("👥 Users", "d:users:0"), button("📦 Orders", "d:orders:recent:0")],
    [button("💳 Payments", "d:payments"), button("⚙️ Worker health", "d:workers")],
    [button("🔐 Security", "d:security"), button("⭐ Review queue", "d:reviews:0")],
  ];
  const text = [
    "<b>📊 Platform overview</b>",
    `Users: <code>${users.toLocaleString()}</code> · Orders: <code>${orders.toLocaleString()}</code>`,
    `Paid deposits: <code>${paid.toLocaleString()}</code> · Pending: <code>${pending.toLocaleString()}</code>`,
    `Wallet balances: <code>${fmtMoney(totals.totalBalance)}</code> · Total spent: <code>${fmtMoney(totals.totalSpent)}</code>`,
    `Open payment issues: <code>${openIssues.toLocaleString()}</code>`,
    `IMAP worker: <b>${escapeHtml(health?.status || "not reported")}</b> · Last success: <code>${escapeHtml(fmtDate(health?.last_success_at))}</code>`,
  ].join("\n");
  await render(ctx, text, addNavigation(rows, "d:home", "d:overview"));
}

async function renderUsers(ctx: any, requestedPage = 0) {
  const database = await getDatabase();
  const total = await database.collection("users").countDocuments();
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(toPage(String(requestedPage)), pageCount - 1);
  const users: any[] = await database.collection("users").find({})
    .sort({ created_at: -1, _id: -1 }).skip(page * PAGE_SIZE).limit(PAGE_SIZE).toArray();
  const rows = [[button("🔎 Search by email", "d:usersearch")]];
  const lines = [`<b>👥 Users · ${total.toLocaleString()} total</b>`, "Latest registered accounts:"];
  for (const user of users) {
    const email = String(user.email || "(pseudonymized account)");
    const flags = [user.account_locked ? "locked" : "", user.ordering_hold ? "order hold" : "", user.payment_hold ? "payment hold" : ""].filter(Boolean).join(" · ");
    rows.push([button(`${email.slice(0, 42)}${flags ? ` · ${flags}` : ""}`, `d:user:${idString(user._id)}:u:${page}`)]);
  }
  if (!users.length) lines.push("No user records found.");
  await render(ctx, lines.join("\n"), pageNavigation(rows, page, pageCount, (next) => `d:users:${next}`, "d:home", `d:users:${page}`));
}

async function renderUser(ctx: any, rawId: string, backCallback = "d:users:0", refreshCallback?: string) {
  const database = await getDatabase();
  const user: any = await getUserById(database, rawId);
  if (!user) {
    await render(ctx, "<b>User not found.</b> The account may have been removed or pseudonymized.", addNavigation([], "d:users:0"));
    return;
  }
  const [keyCount, activeSessions, orderCount, transactionCount] = await Promise.all([
    database.collection("api_keys").countDocuments({ user_id: user._id, status: { $ne: "archived" } }),
    database.collection("sessions").countDocuments({ $or: [{ user_id: user._id }, { actor_admin_id: user._id }], revoked_at: null, expires_at: { $gt: new Date() } }),
    database.collection("orders").countDocuments({ user_id: user._id }),
    database.collection("transactions").countDocuments({ user_id: user._id }),
  ]);
  const email = String(user.email || "(pseudonymized account)");
  const rows = [
    [button("📦 Orders", `d:records:orders:${idString(user._id)}:0`), button("💳 Transactions", `d:records:deposits:${idString(user._id)}:0`)],
    [button("📒 Wallet", `d:records:wallet:${idString(user._id)}:0`), button("🛡 Events", `d:records:events:${idString(user._id)}:0`)],
    [button("🖥 Sessions", `d:sessions:${idString(user._id)}:0`), button("🔑 API keys", `d:keys:${idString(user._id)}:0`)],
    [button("🛡 Account controls", `d:controls:${idString(user._id)}`), button("🔐 Recovery & support", `d:recovery:${idString(user._id)}`)],
    [button("➕ Credit", `d:money:${idString(user._id)}:wallet_credit`), button("➖ Debit", `d:money:${idString(user._id)}:wallet_debit`)],
    [button("📝 Add owner note", `d:note:${idString(user._id)}`), button(user.account_locked ? "Support Access unavailable while locked" : "👁 Support Access", user.account_locked ? "d:noop" : `d:support:${idString(user._id)}`)],
    [button("🚫 Revoke all sessions", `sessions-revoke-prompt:${idString(user._id)}`)],
  ];
  const text = [
    `<b>👤 User profile</b>`,
    `Email: <code>${escapeHtml(email)}</code>`,
    `Immutable ID: <code>${idString(user._id)}</code>`,
    `Balance: <b>${fmtMoney(user.balance)}</b> · Spent: <code>${fmtMoney(user.total_spent)}</code>`,
    `Orders: <code>${orderCount}</code> · Transactions: <code>${transactionCount}</code> · API keys: <code>${keyCount}</code>`,
    `Sessions: <code>${activeSessions}</code> · Registered: <code>${escapeHtml(fmtDate(user.created_at))}</code>`,
    `Account: <b>${user.account_locked ? "LOCKED" : "ACTIVE"}</b> · Ordering: <b>${user.ordering_hold ? "HELD" : "OPEN"}</b> · Payments: <b>${user.payment_hold ? "HELD" : "OPEN"}</b>`,
  ].join("\n");
  await render(ctx, text, addNavigation(rows, backCallback, refreshCallback || `d:user:${idString(user._id)}`));
}

async function renderUserRecords(ctx: any, kind: RecordKind, rawUserId: string, requestedPage = 0) {
  const database = await getDatabase();
  const user: any = await getUserById(database, rawUserId);
  if (!user) {
    await render(ctx, "<b>User not found.</b>", addNavigation([], "d:users:0"));
    return;
  }
  const collectionName: Record<RecordKind, string> = {
    orders: "orders", deposits: "transactions", wallet: "wallet_ledger", events: "security_events", notes: "admin_notes",
  };
  const collection = database.collection(collectionName[kind]);
  const filter = { user_id: user._id };
  const total = await collection.countDocuments(filter);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(toPage(String(requestedPage)), pageCount - 1);
  const records: any[] = await collection.find(filter).sort({ created_at: -1, _id: -1 }).skip(page * PAGE_SIZE).limit(PAGE_SIZE).toArray();
  const rows: any[][] = [];
  const email = escapeHtml(user.email || "(pseudonymized account)");
  const lines = [`<b>${recordTitle(kind)} · ${email}</b>`, `Page ${page + 1}/${pageCount} · ${total} record${total === 1 ? "" : "s"}`];

  for (const item of records) {
    if (kind === "orders") {
      const status = escapeHtml(item.status || "unknown");
      lines.push(`• <b>${status}</b> · ${fmtMoney(item.charge)} · ${escapeHtml(item.service_name || item.service_id || "service")}`);
      rows.push([button(`Open order ${shortId(item._id)} · ${status}`, `d:order:${idString(item._id)}:u:${idString(user._id)}:${page}`)]);
    } else if (kind === "deposits") {
      lines.push(`• <b>${escapeHtml(item.status || "unknown")}</b> · ${fmtMoney(item.amount)} · ${escapeHtml(item.memo || item.method || "transaction")}`);
      rows.push([button(`Open transaction ${shortId(item._id)}`, `d:txn:${idString(item._id)}:u:${idString(user._id)}:${page}`)]);
    } else if (kind === "wallet") {
      const amount = Number(item.amount || 0);
      lines.push(`${amount >= 0 ? "＋" : "−"}${fmtMoney(Math.abs(amount))} · ${escapeHtml(item.type || "entry")} · ${escapeHtml(item.source || "admin")} · <code>${escapeHtml(item.settlement_key || shortId(item._id))}</code> · ${escapeHtml(fmtDate(item.created_at))}`);
    } else if (kind === "events") {
      lines.push(`• <b>${escapeHtml(item.type || "event")}</b> · ${escapeHtml(fmtDate(item.created_at))}`);
    } else {
      lines.push(`• ${escapeHtml(String(item.note || "").slice(0, 260))} · ${escapeHtml(fmtDate(item.created_at))}`);
    }
  }
  if (!records.length) lines.push("No records found for this section.");
  if (kind === "events") rows.push([button("📝 Owner notes", `d:records:notes:${idString(user._id)}:0`)]);
  if (kind === "notes") rows.push([button("🛡 Security events", `d:records:events:${idString(user._id)}:0`)]);
  await render(ctx, lines.join("\n"), pageNavigation(rows, page, pageCount, (next) => `d:records:${kind}:${idString(user._id)}:${next}`, `d:user:${idString(user._id)}`, `d:records:${kind}:${idString(user._id)}:${page}`));
}

function recordTitle(kind: RecordKind): string {
  return ({ orders: "📦 User orders", deposits: "💳 User transactions", wallet: "📒 Wallet ledger", events: "🛡 Security events", notes: "📝 Owner notes" } as const)[kind];
}

function orderFilter(mode: OrderMode): any {
  return mode === "failed" ? { $or: [{ refund_status: "requires_admin_review" }, { status: "Failed" }] } : {};
}

async function renderOrders(ctx: any, mode: OrderMode, requestedPage = 0) {
  const database = await getDatabase();
  const filter = orderFilter(mode);
  const total = await database.collection("orders").countDocuments(filter);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(toPage(String(requestedPage)), pageCount - 1);
  const orders: any[] = await database.collection("orders").find(filter).sort({ created_at: -1, _id: -1 }).skip(page * PAGE_SIZE).limit(PAGE_SIZE).toArray();
  const lines = [mode === "failed" ? `<b>🚨 Failed / review-required orders</b>` : `<b>📦 Recent orders</b>`, `Page ${page + 1}/${pageCount} · ${total} total`];
  const rows: any[][] = [];
  for (const order of orders) {
    const status = escapeHtml(order.status || "unknown");
    lines.push(`• <b>${status}</b> · ${fmtMoney(order.charge)} · ${escapeHtml(order.service_name || order.service_id || "service")} · ${escapeHtml(order.user_email || "unknown")}`);
    const modeShort = mode === "failed" ? "f" : "r";
    rows.push([button(`Open order ${shortId(order._id)} · ${status}`, `d:order:${idString(order._id)}:${modeShort}:${page}`)]);
  }
  if (!orders.length) lines.push(mode === "failed" ? "No orders require manual review." : "No orders found.");
  const otherMode: OrderMode = mode === "failed" ? "recent" : "failed";
  rows.push([button(mode === "failed" ? "📦 Recent orders" : "🚨 Failed review queue", `d:orders:${otherMode}:0`)]);
  await render(ctx, lines.join("\n"), pageNavigation(rows, page, pageCount, (next) => `d:orders:${mode}:${next}`, "d:home", `d:orders:${mode}:${page}`));
}

async function renderOrder(ctx: any, rawId: string, origin: string[], backCallback: string) {
  if (!isObjectId(rawId)) return render(ctx, "<b>Invalid order ID.</b>", addNavigation([], backCallback));
  const database = await getDatabase();
  const order: any = await database.collection("orders").findOne({ _id: new ObjectId(rawId) });
  if (!order) return render(ctx, "<b>Order not found.</b>", addNavigation([], backCallback));
  const userId = idString(order.user_id);
  const rows: any[][] = [];
  if (order.refund_status !== "refunded" && Number(order.charge || 0) > 0) rows.push([button("↩️ Stage reviewed refund", `d:refund:${idString(order._id)}`)]);
  if (isObjectId(userId)) {
    const profileRoute = origin[0] === "u" && isObjectId(origin[1])
      ? `d:user:${userId}:ou:${toPage(origin[2])}:${idString(order._id)}`
      : `d:user:${userId}:${origin[0] === "f" ? "of" : "or"}:${idString(order._id)}:${toPage(origin[1])}`;
    rows.push([button("👤 Open user profile", profileRoute)]);
  }
  rows.push([button("🚨 Failed review queue", "d:orders:failed:0"), button("📦 Recent orders", "d:orders:recent:0")]);
  const text = [
    `<b>📦 Order details</b>`,
    `ID: <code>${idString(order._id)}</code>`,
    `Status: <b>${escapeHtml(order.status || "unknown")}</b> · Refund: <b>${escapeHtml(order.refund_status || "none")}</b>`,
    `User: <code>${escapeHtml(order.user_email || "unknown")}</code>`,
    `Service: ${escapeHtml(order.service_name || order.service_id || "unknown")}`,
    `Provider order: <code>${escapeHtml(order.provider_order_id || "not accepted")}</code>`,
    `Charge: <b>${fmtMoney(order.charge)}</b> · Quantity: <code>${Number(order.quantity || 0)}</code>`,
    `Target: <code>${escapeHtml(String(order.link || "—").slice(0, 240))}</code>`,
    `Refund state: <code>${escapeHtml(order.refund_status || "none")}</code>`,
    order.provider_error ? "Provider note: <code>recorded; internal details omitted from dashboard</code>" : "",
    `Created: <code>${escapeHtml(fmtDate(order.created_at))}</code>`,
  ].filter(Boolean).join("\n");
  const refresh = origin[0] === "u" && isObjectId(origin[1])
    ? `d:order:${idString(order._id)}:u:${origin[1]}:${toPage(origin[2])}`
    : `d:order:${idString(order._id)}:${origin[0] === "f" ? "f" : "r"}:${toPage(origin[1])}`;
  await render(ctx, text, addNavigation(rows, backCallback, refresh));
}

function orderBack(origin: string[]): string {
  if (origin[0] === "u" && isObjectId(origin[1])) return `d:records:orders:${origin[1]}:${toPage(origin[2])}`;
  if (origin[0] === "f") return `d:orders:failed:${toPage(origin[1])}`;
  return `d:orders:recent:${toPage(origin[1])}`;
}

async function renderPayments(ctx: any) {
  const database = await getDatabase();
  const [pending, openIssues, paid] = await Promise.all([
    database.collection("transactions").countDocuments({ status: "pending" }),
    database.collection("payment_reconciliation").countDocuments({ status: "open" }),
    database.collection("transactions").countDocuments({ status: "paid" }),
  ]);
  const rows = [
    [button(`⏳ Pending requests · ${pending}`, "d:pending:0"), button(`🧾 Recent transactions · ${paid}`, "d:payments:history:0")],
    [button("🔍 Look up memo", "d:memosearch"), button("🧾 Manual reconciliation", "d:reconcile:start")],
    [button(`⚠️ Reconciliation queue · ${openIssues}`, "d:reconciliations:0"), button("📡 Run scan", "worker:scan")],
    [button("⚙️ Worker health", "d:workers"), button("👤 User deposits / wallet", "d:usersearch")],
  ];
  await render(ctx, `<b>💳 Payments workspace</b>\nPending: <code>${pending}</code> · Paid: <code>${paid}</code> · Open issues: <code>${openIssues}</code>\n\nManual settlement always requires exact pending state, amount, memo, receipt identifiers and a confirmed reason.`, addNavigation(rows, "d:home", "d:payments"));
}

async function renderPending(ctx: any, requestedPage = 0) {
  const database = await getDatabase();
  const filter = { status: "pending" };
  const total = await database.collection("transactions").countDocuments(filter);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(toPage(String(requestedPage)), pageCount - 1);
  const records: any[] = await database.collection("transactions").find(filter).sort({ created_at: -1, _id: -1 }).skip(page * PAGE_SIZE).limit(PAGE_SIZE).toArray();
  const rows: any[][] = [];
  const lines = [`<b>⏳ Pending deposits</b> · ${total}`, `Page ${page + 1}/${pageCount}`];
  for (const item of records) {
    lines.push(`• ${fmtMoney(item.amount)} · <code>${escapeHtml(item.memo || "no memo")}</code> · ${escapeHtml(item.user_email || "unknown")} · expires ${escapeHtml(fmtDate(item.expires_at))}`);
    rows.push([button(`Open ${shortId(item._id)} · ${escapeHtml(item.memo || "deposit")}`, `d:txn:${idString(item._id)}:p:${page}`)]);
  }
  if (!records.length) lines.push("No pending deposits are waiting for settlement.");
  await render(ctx, lines.join("\n"), pageNavigation(rows, page, pageCount, (next) => `d:pending:${next}`, "d:payments", `d:pending:${page}`));
}

async function renderTransactionHistory(ctx: any, requestedPage = 0) {
  const database = await getDatabase();
  const total = await database.collection("transactions").countDocuments({});
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(toPage(String(requestedPage)), pageCount - 1);
  const records: any[] = await database.collection("transactions").find({}).sort({ created_at: -1, _id: -1 }).skip(page * PAGE_SIZE).limit(PAGE_SIZE).toArray();
  const rows: any[][] = [];
  const lines = [`<b>🧾 Recent transactions</b> · ${total} total`, `Page ${page + 1}/${pageCount}`];
  for (const item of records) {
    lines.push(`• <b>${escapeHtml(item.status || "unknown")}</b> · ${fmtMoney(item.amount)} · ${escapeHtml(item.memo || item.method || "transaction")} · ${escapeHtml(item.user_email || "unknown")}`);
    rows.push([button(`Open transaction ${shortId(item._id)} · ${escapeHtml(item.status || "unknown")}`, `d:txn:${idString(item._id)}:h:${page}`)]);
  }
  if (!records.length) lines.push("No transactions found.");
  await render(ctx, lines.join("\n"), pageNavigation(rows, page, pageCount, (next) => `d:payments:history:${next}`, "d:payments", `d:payments:history:${page}`));
}

async function renderTransaction(ctx: any, rawId: string, origin: string[]) {
  if (!isObjectId(rawId)) return render(ctx, "<b>Invalid transaction ID.</b>", addNavigation([], "d:payments"));
  const database = await getDatabase();
  const transaction: any = await database.collection("transactions").findOne({ _id: new ObjectId(rawId) });
  if (!transaction) return render(ctx, "<b>Transaction not found.</b>", addNavigation([], "d:payments"));
  const userId = idString(transaction.user_id);
  const rows: any[][] = [];
  if (/^SUP[A-Z0-9]{5}$/i.test(String(transaction.memo || ""))) rows.push([button("📑 Look up memo", `d:memo:${String(transaction.memo).toUpperCase()}`)]);
  if (isObjectId(userId)) {
    const profileRoute = origin[0] === "u" && isObjectId(origin[1])
      ? `d:user:${userId}:tu:${toPage(origin[2])}:${idString(transaction._id)}`
      : origin[0] === "p" ? `d:user:${userId}:tp:${idString(transaction._id)}:${toPage(origin[1])}`
      : origin[0] === "m" && /^SUP[A-Z0-9]{5}$/i.test(origin[1] || "") ? `d:user:${userId}:tm:${String(origin[1]).toUpperCase()}`
      : `d:user:${userId}:th:${idString(transaction._id)}:${toPage(origin[1])}`;
    rows.push([button("👤 Open user profile", profileRoute)]);
  }
  if (["pending", "expired"].includes(String(transaction.status)) && transaction.method === "FAMPAY_UPI" && transaction.memo) {
    rows.push([button("🧾 Stage trusted receipt reconciliation", `d:reconcile:txn:${idString(transaction._id)}`)]);
  }
  const back = origin[0] === "u" && isObjectId(origin[1])
    ? `d:records:deposits:${origin[1]}:${toPage(origin[2])}`
    : origin[0] === "p" ? `d:pending:${toPage(origin[1])}`
    : origin[0] === "m" && /^SUP[A-Z0-9]{5}$/i.test(origin[1] || "") ? `d:memo:${String(origin[1]).toUpperCase()}`
    : origin[0] === "h" ? `d:payments:history:${toPage(origin[1])}` : "d:payments:history:0";
  const text = [
    `<b>💳 Transaction details</b>`,
    `ID: <code>${idString(transaction._id)}</code>`,
    `Status: <b>${escapeHtml(transaction.status || "unknown")}</b> · Method: <code>${escapeHtml(transaction.method || transaction.type || "unknown")}</code>`,
    `User: <code>${escapeHtml(transaction.user_email || "unknown")}</code>`,
    `Amount: <b>${fmtMoney(transaction.amount)}</b> · Memo: <code>${escapeHtml(transaction.memo || "—")}</code>`,
    `UTR/reference: <code>${escapeHtml(transaction.utr || transaction.razorpay_payment_id || "—")}</code>`,
    `Transaction ID: <code>${escapeHtml(transaction.transaction_id || "—")}</code>`,
    `Created: <code>${escapeHtml(fmtDate(transaction.created_at))}</code> · Expires: <code>${escapeHtml(fmtDate(transaction.expires_at))}</code>`,
  ].join("\n");
  const refresh = origin[0] === "u" && isObjectId(origin[1])
    ? `d:txn:${idString(transaction._id)}:u:${origin[1]}:${toPage(origin[2])}`
    : origin[0] === "p" ? `d:txn:${idString(transaction._id)}:p:${toPage(origin[1])}`
    : origin[0] === "m" && /^SUP[A-Z0-9]{5}$/i.test(origin[1] || "") ? `d:txn:${idString(transaction._id)}:m:${String(origin[1]).toUpperCase()}`
    : `d:txn:${idString(transaction._id)}:h:${toPage(origin[1])}`;
  await render(ctx, text, addNavigation(rows, back, refresh));
}

async function renderMemo(ctx: any, rawMemo: string, back = "d:payments") {
  const memo = rawMemo.trim().toUpperCase();
  if (!/^SUP[A-Z0-9]{5}$/.test(memo)) return render(ctx, "<b>Invalid memo.</b> Expected `SUP` plus five letters or digits.", addNavigation([], back));
  const database = await getDatabase();
  const transaction: any = await database.collection("transactions").findOne({ memo });
  if (!transaction) return render(ctx, `Memo <code>${escapeHtml(memo)}</code> was not found.`, addNavigation([[button("🔍 Try another memo", "d:memosearch")]], back, `d:memo:${memo}`));
  const rows = [[button("Open transaction", `d:txn:${idString(transaction._id)}:m:${memo}`)]];
  const text = [
    `<b>📑 Memo lookup</b> · <code>${escapeHtml(memo)}</code>`,
    `User: <code>${escapeHtml(transaction.user_email || "unknown")}</code>`,
    `Amount: <b>${fmtMoney(transaction.amount)}</b> · Status: <b>${escapeHtml(transaction.status || "unknown")}</b>`,
    `Method: <code>${escapeHtml(transaction.method || "unknown")}</code>`,
    `UTR/reference: <code>${escapeHtml(transaction.utr || "—")}</code>`,
    `Transaction ID: <code>${escapeHtml(transaction.transaction_id || "—")}</code>`,
    `Created: <code>${escapeHtml(fmtDate(transaction.created_at))}</code>`,
  ].join("\n");
  await render(ctx, text, addNavigation(rows, back, `d:memo:${memo}`));
}

async function renderReconciliations(ctx: any, requestedPage = 0) {
  const database = await getDatabase();
  const filter = { status: "open" };
  const total = await database.collection("payment_reconciliation").countDocuments(filter);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(toPage(String(requestedPage)), pageCount - 1);
  const issues: any[] = await database.collection("payment_reconciliation").find(filter).sort({ last_seen_at: -1, created_at: -1 }).skip(page * PAGE_SIZE).limit(PAGE_SIZE).toArray();
  const rows: any[][] = [];
  const lines = [`<b>⚠️ Open payment reconciliation issues</b> · ${total}`, `Page ${page + 1}/${pageCount}`];
  for (const issue of issues) {
    lines.push(`• <code>${escapeHtml(issue.memo || "no memo")}</code> · ${escapeHtml(issue.reason || "unknown reason")} · attempts ${Number(issue.attempts || 0)}`);
    rows.push([button(`Inspect ${escapeHtml(issue.memo || shortId(issue._id))}`, `d:reconciliation:${idString(issue._id)}:${page}`)]);
  }
  if (!issues.length) lines.push("No open issues.");
  await render(ctx, lines.join("\n"), pageNavigation(rows, page, pageCount, (next) => `d:reconciliations:${next}`, "d:payments", `d:reconciliations:${page}`));
}

async function renderReconciliation(ctx: any, rawId: string, page: number) {
  if (!isObjectId(rawId)) return render(ctx, "<b>Invalid issue ID.</b>", addNavigation([], `d:reconciliations:${page}`));
  const database = await getDatabase();
  const issue: any = await database.collection("payment_reconciliation").findOne({ _id: new ObjectId(rawId) });
  if (!issue) return render(ctx, "<b>Reconciliation issue not found.</b>", addNavigation([], `d:reconciliations:${page}`));
  const rows: any[][] = [];
  if (/^SUP[A-Z0-9]{5}$/i.test(String(issue.memo || ""))) rows.push([button("📑 Look up memo", `d:memo:${String(issue.memo).toUpperCase()}`)]);
  if (isObjectId(idString(issue.pending_transaction_id))) rows.push([button("Open pending transaction", `d:txn:${idString(issue.pending_transaction_id)}:p:0`)]);
  const text = [
    `<b>⚠️ Reconciliation issue</b>`,
    `Memo: <code>${escapeHtml(issue.memo || "unknown")}</code> · Status: <b>${escapeHtml(issue.status || "unknown")}</b>`,
    `Reason: <code>${escapeHtml(issue.reason || "unknown")}</code> · Attempts: <code>${Number(issue.attempts || 0)}</code>`,
    `Expected: <code>${issue.expected_amount == null ? "—" : fmtMoney(issue.expected_amount)}</code> · Observed: <code>${issue.observed_amount == null ? "—" : fmtMoney(issue.observed_amount)}</code>`,
    `Last seen: <code>${escapeHtml(fmtDate(issue.last_seen_at))}</code>`,
    issue.last_error ? "Last error: <code>recorded; details omitted from dashboard</code>" : "",
  ].filter(Boolean).join("\n");
  await render(ctx, text, addNavigation(rows, `d:reconciliations:${page}`, `d:reconciliation:${idString(issue._id)}:${page}`));
}

async function renderControls(ctx: any, rawUserId: string) {
  const database = await getDatabase();
  const user: any = await getUserById(database, rawUserId);
  if (!user) return render(ctx, "<b>User not found.</b>", addNavigation([], "d:users:0"));
  const id = idString(user._id);
  const choices: Array<[string, ControlAction]> = [
    [user.account_locked ? "🔓 Unlock account" : "🔒 Lock account", user.account_locked ? "account_unlock" : "account_lock"],
    [user.ordering_hold ? "▶️ Release ordering hold" : "⏸ Hold ordering", user.ordering_hold ? "ordering_release" : "ordering_hold"],
    [user.payment_hold ? "▶️ Release payment hold" : "⏸ Hold payments", user.payment_hold ? "payment_release" : "payment_hold"],
  ];
  const rows: any[][] = choices.map(([label, action]) => [button(label, `d:control:${id}:${action}`)]);
  const text = [
    `<b>🛡 Account controls</b> · <code>${escapeHtml(user.email || "(pseudonymized)")}</code>`,
    `Account lock: <b>${user.account_locked ? "ON" : "OFF"}</b>`,
    `Ordering hold: <b>${user.ordering_hold ? "ON" : "OFF"}</b>`,
    `Payment hold: <b>${user.payment_hold ? "ON" : "OFF"}</b>`,
    "Every change asks for a reason and requires the existing one-time confirmation.",
  ].join("\n");
  await render(ctx, text, addNavigation(rows, `d:user:${id}`, `d:controls:${id}`));
}

async function renderKeys(ctx: any, rawUserId: string, requestedPage = 0) {
  const database = await getDatabase();
  const user: any = await getUserById(database, rawUserId);
  if (!user) return render(ctx, "<b>User not found.</b>", addNavigation([], "d:users:0"));
  const filter = { user_id: user._id };
  const total = await database.collection("api_keys").countDocuments(filter);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(toPage(String(requestedPage)), pageCount - 1);
  const keys: any[] = await database.collection("api_keys").find(filter).sort({ created_at: -1, _id: -1 }).skip(page * PAGE_SIZE).limit(PAGE_SIZE).toArray();
  const rows: any[][] = [];
  const lines = [`<b>🔑 API-key identities</b> · <code>${escapeHtml(user.email || "(pseudonymized)")}</code>`, `Page ${page + 1}/${pageCount} · ${total} total`];
  for (const key of keys) {
    lines.push(`• <b>${escapeHtml(key.name || "Unnamed key")}</b> · ${escapeHtml(key.status || "unknown")} · <code>${escapeHtml(key.public_id || key.prefix || "n/a")}</code>`);
    rows.push([button(`Open ${String(key.name || key.public_id || shortId(key._id)).slice(0, 32)}`, `d:key:${idString(key._id)}:${idString(user._id)}:${page}`)]);
  }
  if (!keys.length) lines.push("No dedicated API-key identities found.");
  await render(ctx, lines.join("\n"), pageNavigation(rows, page, pageCount, (next) => `d:keys:${idString(user._id)}:${next}`, `d:user:${idString(user._id)}`, `d:keys:${idString(user._id)}:${page}`));
}

async function renderKey(ctx: any, rawKeyId: string, originUserId = "", originPage = 0) {
  if (!isObjectId(rawKeyId)) return render(ctx, "<b>Invalid key ID.</b>", addNavigation([], "d:home"));
  const database = await getDatabase();
  const key: any = await database.collection("api_keys").findOne({ _id: new ObjectId(rawKeyId) });
  if (!key) return render(ctx, "<b>API-key identity not found.</b>", addNavigation([], "d:home"));
  const keyId = idString(key._id);
  const userId = idString(key.user_id);
  const rows: any[][] = [];
  if (key.status === "paused") rows.push([button("▶️ Resume key", `d:key-action:${keyId}:api_resume`)]);
  else if (key.status !== "archived") rows.push([button("⏸ Pause key", `d:key-action:${keyId}:api_pause`)]);
  if (key.status !== "archived") {
    rows.push([button("🔁 Require secure reissue", `d:key-action:${keyId}:api_reissue_required`)]);
    rows.push([button("🗄 Archive permanently", `d:key-action:${keyId}:api_archive`)]);
  }
  if (isObjectId(userId)) rows.push([button("👤 Back to user profile", `d:user:${userId}`)]);
  const text = [
    `<b>🔑 API-key identity</b> · ${escapeHtml(key.name || "Unnamed key")}`,
    `ID: <code>${keyId}</code>`,
    `Public ID: <code>${escapeHtml(key.public_id || key.prefix || "n/a")}</code>`,
    `Status: <b>${escapeHtml(key.status || "unknown")}</b> · Reissue required: <b>${key.owner_reissue_required ? "yes" : "no"}</b>`,
    `Scopes: <code>${escapeHtml(Array.isArray(key.scopes) ? key.scopes.join(", ") : "—")}</code>`,
    `Created: <code>${escapeHtml(fmtDate(key.created_at))}</code> · Last used: <code>${escapeHtml(fmtDate(key.last_used_at))}</code>`,
    "Raw API secrets are never displayed or generated in Telegram.",
  ].join("\n");
  const back = isObjectId(originUserId) ? `d:keys:${originUserId}:${toPage(String(originPage))}` : isObjectId(userId) ? `d:keys:${userId}:0` : "d:home";
  await render(ctx, text, addNavigation(rows, back, `d:key:${keyId}:${isObjectId(originUserId) ? originUserId : userId}:${toPage(String(originPage))}`));
}

async function renderSessions(ctx: any, rawUserId: string, requestedPage = 0) {
  const database = await getDatabase();
  const user: any = await getUserById(database, rawUserId);
  if (!user) return render(ctx, "<b>User not found.</b>", addNavigation([], "d:users:0"));
  const now = new Date();
  const filter = { $or: [{ user_id: user._id }, { actor_admin_id: user._id }], revoked_at: null, expires_at: { $gt: now } };
  const total = await database.collection("sessions").countDocuments(filter);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(toPage(String(requestedPage)), pageCount - 1);
  const sessions: any[] = await database.collection("sessions").find(filter).sort({ last_activity_at: -1, created_at: -1 }).skip(page * PAGE_SIZE).limit(PAGE_SIZE).toArray();
  const restrictedCount = await database.collection("restricted_sessions").countDocuments({ user_id: user._id, invalidated_at: null, expires_at: { $gt: now } });
  const rows: any[][] = [];
  const lines = [`<b>🖥 Active sessions</b> · <code>${escapeHtml(user.email || "(pseudonymized)")}</code>`, `Normal/support: ${total} · Restricted recovery: ${restrictedCount} · Page ${page + 1}/${pageCount}`];
  for (const session of sessions) {
    const purpose = session.purpose === "admin_impersonation" ? "Support Access (read-only)" : "Normal website session";
    lines.push(`• <b>${purpose}</b> · ${escapeHtml(fmtDate(session.last_activity_at || session.created_at))} · <code>${escapeHtml(String(session.device?.platform || session.device?.user_agent || "Unknown").slice(0, 80))}</code>`);
    rows.push([button(`Revoke session ${shortId(session._id)}`, `session-revoke-prompt:${idString(session._id)}`)]);
  }
  if (!sessions.length) lines.push("No active website sessions.");
  rows.push([button("🚫 Revoke all user sessions", `sessions-revoke-prompt:${idString(user._id)}`)]);
  await render(ctx, lines.join("\n"), pageNavigation(rows, page, pageCount, (next) => `d:sessions:${idString(user._id)}:${next}`, `d:user:${idString(user._id)}`, `d:sessions:${idString(user._id)}:${page}`));
}

async function renderRecovery(ctx: any, rawUserId: string) {
  const database = await getDatabase();
  const user: any = await getUserById(database, rawUserId);
  if (!user) return render(ctx, "<b>User not found.</b>", addNavigation([], "d:users:0"));
  const rows = [
    [button("🔐 Generate temporary password", `d:reset-mode:${idString(user._id)}:generated`)],
    [button("🔐 Owner-selected temporary password", `d:reset-mode:${idString(user._id)}:owner_selected`)],
    [button(user.account_locked ? "Support Access unavailable while locked" : "👁 Issue read-only Support Access", user.account_locked ? "d:noop" : `d:support:${idString(user._id)}`)],
    [button("🖥 Review sessions", `d:sessions:${idString(user._id)}:0`)],
  ];
  const text = [
    `<b>🔐 Recovery &amp; support</b> · <code>${escapeHtml(user.email || "(pseudonymized)")}</code>`,
    "Temporary-password reset requires an identity checklist, a reason and a separate confirmation. The generated or owner-selected credential is shown once.",
    "Support Access is a one-time code for a separate 15-minute read-only website session.",
  ].join("\n\n");
  await render(ctx, text, addNavigation(rows, `d:user:${idString(user._id)}`, `d:recovery:${idString(user._id)}`));
}

async function renderSecurity(ctx: any) {
  const database = await getDatabase();
  const [locked, held, flagged, eventCount] = await Promise.all([
    database.collection("users").countDocuments({ account_locked: true }),
    database.collection("users").countDocuments({ $or: [{ ordering_hold: true }, { payment_hold: true }] }),
    database.collection("users").countDocuments({ $or: [{ account_locked: true }, { ordering_hold: true }, { payment_hold: true }] }),
    database.collection("security_events").countDocuments(),
  ]);
  const rows = [
    [button("🔎 Find user / security controls", "d:usersearch")],
    [button(`🔒 Locked or held accounts · ${flagged}`, "d:security:flagged:0")],
    [button(`📜 Recent security events · ${eventCount}`, "d:security:events:0")],
    [button("👥 Users", "d:users:0"), button("🔐 Find account for recovery", "d:usersearch")],
  ];
  await render(ctx, `<b>🔐 Security workspace</b>\nLocked accounts: <code>${locked}</code> · Accounts with holds: <code>${held}</code> · Locked or held: <code>${flagged}</code> · Recorded events: <code>${eventCount}</code>\n\nSelect an account to inspect its sessions, account state, recovery and API-key controls.`, addNavigation(rows, "d:home", "d:security"));
}

async function renderFlaggedUsers(ctx: any, requestedPage = 0) {
  const database = await getDatabase();
  const filter = { $or: [{ account_locked: true }, { ordering_hold: true }, { payment_hold: true }] };
  const total = await database.collection("users").countDocuments(filter);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(toPage(String(requestedPage)), pageCount - 1);
  const users: any[] = await database.collection("users").find(filter).sort({ updated_at: -1, created_at: -1 }).skip(page * PAGE_SIZE).limit(PAGE_SIZE).toArray();
  const rows: any[][] = [];
  const lines = [`<b>🔒 Locked / held accounts</b> · ${total}`, `Page ${page + 1}/${pageCount}`];
  for (const user of users) {
    const flags = [user.account_locked ? "locked" : "", user.ordering_hold ? "ordering held" : "", user.payment_hold ? "payments held" : ""].filter(Boolean).join(" · ");
    lines.push(`• <code>${escapeHtml(user.email || "(pseudonymized account)")}</code> · ${escapeHtml(flags)}`);
    rows.push([button(`Inspect ${String(user.email || shortId(user._id)).slice(0, 32)}`, `d:user:${idString(user._id)}:sf:${page}`)]);
  }
  if (!users.length) lines.push("No locked or held accounts.");
  await render(ctx, lines.join("\n"), pageNavigation(rows, page, pageCount, (next) => `d:security:flagged:${next}`, "d:security", `d:security:flagged:${page}`));
}

async function renderSecurityEvents(ctx: any, requestedPage = 0) {
  const database = await getDatabase();
  const total = await database.collection("security_events").countDocuments();
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(toPage(String(requestedPage)), pageCount - 1);
  const events: any[] = await database.collection("security_events").find({}).sort({ created_at: -1, _id: -1 }).skip(page * PAGE_SIZE).limit(PAGE_SIZE).toArray();
  const rows: any[][] = [];
  const lines = [`<b>📜 Recent security events</b> · ${total}`, `Page ${page + 1}/${pageCount}`];
  for (const event of events) {
    lines.push(`• <b>${escapeHtml(event.type || "event")}</b> · ${escapeHtml(fmtDate(event.created_at))} · ${escapeHtml(event.user_email || idString(event.user_id) || "unknown user")}`);
    if (isObjectId(idString(event.user_id))) rows.push([button(`Open subject ${shortId(event.user_id)}`, `d:user:${idString(event.user_id)}:se:${page}`)]);
  }
  if (!events.length) lines.push("No security events found.");
  await render(ctx, lines.join("\n"), pageNavigation(rows, page, pageCount, (next) => `d:security:events:${next}`, "d:security", `d:security:events:${page}`));
}

async function renderReviews(ctx: any, requestedPage = 0, notice = "") {
  const database = await getDatabase();
  const filter = { seed: { $ne: true } };
  const total = await database.collection("reviews").countDocuments(filter);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(toPage(String(requestedPage)), pageCount - 1);
  const reviews: any[] = await database.collection("reviews").find(filter).sort({ created_at: -1, _id: -1 }).skip(page * PAGE_SIZE).limit(PAGE_SIZE).toArray();
  const rows: any[][] = [];
  const lines = [`<b>⭐ Buyer review moderation</b> · ${total} review${total === 1 ? "" : "s"}`, `Page ${page + 1}/${pageCount}`, notice ? `<i>${escapeHtml(notice)}</i>` : ""];
  for (const review of reviews) {
    const status = review.status === "hidden" ? "hidden" : "approved";
    const username = String(review.username || "Buyer").slice(0, 70);
    const rating = Math.max(1, Math.min(5, Number(review.rating) || 1));
    lines.push(`\n<b>${escapeHtml(username)}</b> · ${"★".repeat(rating)} · <code>${status.toUpperCase()}</code>\n${escapeHtml(String(review.text || "").slice(0, 220))}`);
    rows.push([button(status === "hidden" ? `👁 Restore ${username.slice(0, 22)}` : `🙈 Hide ${username.slice(0, 22)}`, `d:review-toggle:${idString(review._id)}:${status}:${page}`)]);
  }
  if (!reviews.length) lines.push("No buyer-submitted reviews. Seeded homepage reviews are not in this moderation queue.");
  await render(ctx, lines.filter(Boolean).join("\n"), pageNavigation(rows, page, pageCount, (next) => `d:reviews:${next}`, "d:home", `d:reviews:${page}`));
}

async function renderWorkers(ctx: any) {
  const database = await getDatabase();
  const [health, lease, openIssues, pending] = await Promise.all([
    database.collection<any>("system_health").findOne({ _id: "imap_settlement_worker" }),
    database.collection<any>("worker_leases").findOne({ _id: "imap_settlement" }),
    database.collection("payment_reconciliation").countDocuments({ status: "open" }),
    database.collection("transactions").countDocuments({ status: "pending" }),
  ]);
  const leaseActive = Boolean(lease?.lease_until && new Date(lease.lease_until).getTime() > Date.now());
  const rows = [
    [button("📡 Run one manual scan", "worker:scan")],
    [button(`⚠️ Reconciliation queue · ${openIssues}`, "d:reconciliations:0"), button(`⏳ Pending deposits · ${pending}`, "d:pending:0")],
    [button("💳 Payments", "d:payments"), button("📊 Overview", "d:overview")],
  ];
  const text = [
    "<b>⚙️ Worker health</b>",
    `Status: <b>${escapeHtml(health?.status || "not reported")}</b> · Consecutive errors: <code>${Number(health?.consecutive_errors || 0)}</code>`,
    `Heartbeat: <code>${escapeHtml(fmtDate(health?.heartbeat_at))}</code>`,
    `Last success: <code>${escapeHtml(fmtDate(health?.last_success_at))}</code> · Last error: <code>${escapeHtml(fmtDate(health?.last_error_at))}</code>`,
    health?.last_error ? "Last error: <code>recorded; details omitted from dashboard</code>" : "Last error: <code>none recorded</code>",
    `Lease: <b>${leaseActive ? "ACTIVE" : "available/expired"}</b> · Holder: <code>${escapeHtml(lease?.holder || "none")}</code> · Until: <code>${escapeHtml(fmtDate(lease?.lease_until))}</code>`,
    `Pending deposits: <code>${pending}</code> · Open issues: <code>${openIssues}</code>`,
    process.env.ENABLE_IMAP_WORKER === "false" ? "<i>Automatic worker is disabled by ENABLE_IMAP_WORKER=false.</i>" : "<i>Automatic worker is enabled by runtime configuration.</i>",
  ].join("\n");
  await render(ctx, text, addNavigation(rows, "d:home", "d:workers"));
}

async function renderCommandReference(ctx: any) {
  const text = [
    "<b>📘 Command reference</b>",
    "Every command remains available alongside the button workflows.",
    "<b>Navigation &amp; lookup</b>",
    "<code>/start</code> · <code>/help</code> · <code>/menu</code> · <code>/cancel</code> · <code>/stats</code>",
    "<code>/user &lt;email&gt;</code> · <code>/userorders &lt;email&gt;</code> · <code>/deposits &lt;email&gt;</code> · <code>/wallet &lt;email&gt;</code> · <code>/events &lt;email&gt;</code>",
    "<code>/orders [limit]</code> · <code>/failed</code> · <code>/pending</code> · <code>/checkmemo &lt;memo&gt;</code> · <code>/reviews [limit]</code> · <code>/scan</code>",
    "<b>Financial / account controls</b>",
    "<code>/credit</code> · <code>/debit</code> · <code>/refund</code> · <code>/settleupi</code> · <code>/lock</code> · <code>/unlock</code>",
    "<code>/orderhold</code> · <code>/orderrelease</code> · <code>/paymenthold</code> · <code>/paymentrelease</code>",
    "<b>Keys / recovery</b>",
    "<code>/keypause</code> · <code>/keyresume</code> · <code>/keyarchive</code> · <code>/keyreissue</code> · <code>/note</code>",
    "<code>/resetpassword</code> · <code>/supportaccess</code>",
    "Sensitive commands keep the required <code>| reason</code> separator and existing Confirm/Cancel safeguards. Button workflows collect arbitrary values through guided prompts.",
  ].join("\n\n");
  const rows = [
    [button("👥 Users", "d:users:0"), button("📦 Orders", "d:orders:recent:0")],
    [button("💳 Payments", "d:payments"), button("🔐 Security", "d:security")],
  ];
  await render(ctx, text, addNavigation(rows, "d:home", "d:commands"));
}

async function startUserSearch(ctx: any) {
  await beginFlow(ctx, { kind: "user_search" }, "<b>Find a user</b>\nEnter the account email. The lookup uses the account’s stored email and returns the owner-only profile.");
}

async function startMoneyFlow(ctx: any, userId: string, action: MoneyAction) {
  const user = await getUserById(await getDatabase(), userId);
  if (!user) return render(ctx, "<b>User not found.</b>", addNavigation([], "d:users:0"));
  const label = action === "wallet_credit" ? "credit" : "debit";
  await beginFlow(ctx, { kind: "money", userId, action, step: "amount" }, `<b>Wallet ${label}</b> · <code>${escapeHtml(user.email || "(pseudonymized account)")}</code>\nEnter the amount in rupees (up to two decimal places).`);
}

async function startReconcileFlow(ctx: any, transactionId?: string) {
  if (transactionId && isObjectId(transactionId)) {
    const database = await getDatabase();
    const transaction: any = await database.collection("transactions").findOne({ _id: new ObjectId(transactionId), method: "FAMPAY_UPI", status: { $in: ["pending", "expired"] } });
    if (!transaction) return render(ctx, "<b>This is no longer an eligible Direct UPI request.</b>", addNavigation([], "d:payments"));
    const expectedAmountPaise = Math.round(Number(transaction.amount || 0) * 100);
    await beginFlow(ctx, {
      kind: "settleupi", step: "amount", memo: String(transaction.memo || "").toUpperCase(), pendingId: idString(transaction._id),
      userId: idString(transaction.user_id), userEmail: String(transaction.user_email || "unknown"), expectedAmountPaise,
    }, `🧾 <b>Manual receipt reconciliation</b>\nMemo <code>${escapeHtml(transaction.memo || "")}</code> · Stored amount <b>${fmtMoney(transaction.amount)}</b>.\nEnter the exact amount shown on the trusted incoming receipt.`);
    return;
  }
  await beginFlow(ctx, { kind: "settleupi", step: "memo" }, "🧾 <b>Manual Direct UPI reconciliation</b>\nEnter the exact SUP memo from the pending or expired request.");
}

async function processFlowInput(ctx: any, flow: WizardFlow, rawText: string) {
  const text = rawText.trim();
  if (!text) {
    await ask(ctx, "Please enter a value, or cancel this flow.");
    return;
  }
  const database = await getDatabase();

  if (flow.kind === "user_search") {
    const email = text.toLowerCase();
    if (!isEmail(email)) return ask(ctx, "That email format looks invalid. Enter the user’s email, or cancel.");
    const user: any = await database.collection("users").findOne({ email });
    if (!user) {
      await ask(ctx, "No user matched that email. Enter another email, or cancel.");
      return;
    }
    clearFlow(ctx);
    await renderUser(ctx, idString(user._id));
    return;
  }

  if (flow.kind === "memo_search") {
    const memo = text.toUpperCase();
    if (!/^SUP[A-Z0-9]{5}$/.test(memo)) return ask(ctx, "Memo must be exactly `SUP` plus five letters or digits. Try again, or cancel.");
    clearFlow(ctx);
    await renderMemo(ctx, memo);
    return;
  }

  if (flow.kind === "money") {
    if (flow.step === "amount") {
      const amountPaise = parseAmountPaise(text);
      if (!amountPaise) return ask(ctx, "Enter a positive amount with at most two decimal places, within the configured admin limit.");
      setFlow(ctx, { ...flow, step: "reason", amountPaise });
      await ask(ctx, `Amount: <b>${fmtMoney(amountPaise / 100)}</b>. Now enter the exact reason (5–500 characters).`);
      return;
    }
    if (text.length < 5 || text.length > 500) return ask(ctx, "Reason must be 5–500 characters. Try again, or cancel.");
    const user: any = await getUserById(database, flow.userId);
    if (!user) {
      clearFlow(ctx);
      await ask(ctx, "The user no longer exists. This flow was cancelled.");
      return;
    }
    const actionName = flow.action === "wallet_credit" ? "wallet credit" : "wallet debit";
    const summary = `${flow.action === "wallet_credit" ? "💰" : "🔻"} <b>Confirm ${actionName}</b>\nUser: <code>${escapeHtml(user.email || "(pseudonymized account)")}</code>\nAmount: <b>${fmtMoney((flow.amountPaise || 0) / 100)}</b>\nCurrent balance: <code>${fmtMoney(user.balance)}</code>\nReason: ${escapeHtml(text)}`;
    clearFlow(ctx);
    await queueAdminAction(ctx, flow.action, { user_id: idString(user._id), amount_paise: flow.amountPaise, reason: text }, summary);
    return;
  }

  if (flow.kind === "control") {
    if (text.length < 5 || text.length > 500) return ask(ctx, "Reason must be 5–500 characters. Try again, or cancel.");
    const user: any = await getUserById(database, flow.userId);
    if (!user) {
      clearFlow(ctx);
      await ask(ctx, "The user no longer exists. This flow was cancelled.");
      return;
    }
    const actionLabel = flow.action.replace(/_/g, " ");
    const summary = `🛡 <b>Confirm ${escapeHtml(actionLabel)}</b>\nUser: <code>${escapeHtml(user.email || "(pseudonymized account)")}</code>\nReason: ${escapeHtml(text)}`;
    clearFlow(ctx);
    await queueAdminAction(ctx, flow.action, { user_id: idString(user._id), reason: text }, summary);
    return;
  }

  if (flow.kind === "key") {
    if (text.length < 5 || text.length > 500) return ask(ctx, "Reason must be 5–500 characters. Try again, or cancel.");
    if (!isObjectId(flow.keyId)) {
      clearFlow(ctx);
      await ask(ctx, "Invalid key reference. This flow was cancelled.");
      return;
    }
    const key: any = await database.collection("api_keys").findOne({ _id: new ObjectId(flow.keyId) });
    if (!key) {
      clearFlow(ctx);
      await ask(ctx, "The API-key identity no longer exists. This flow was cancelled.");
      return;
    }
    const label = flow.action.replace("api_", "").replace(/_/g, " ");
    const summary = `🔑 <b>Confirm API-key ${escapeHtml(label)}</b>\nKey: <code>${escapeHtml(key.name || "Unnamed key")}</code>\nPublic ID: <code>${escapeHtml(key.public_id || key.prefix || "n/a")}</code>\nReason: ${escapeHtml(text)}\n\n<i>No raw API secret will be sent through Telegram.</i>`;
    clearFlow(ctx);
    await queueAdminAction(ctx, flow.action, { key_id: idString(key._id), user_id: idString(key.user_id), reason: text }, summary);
    return;
  }

  if (flow.kind === "refund") {
    if (text.length < 5 || text.length > 500) return ask(ctx, "Refund reason must be 5–500 characters. Try again, or cancel.");
    if (!isObjectId(flow.orderId)) {
      clearFlow(ctx);
      await ask(ctx, "Invalid order reference. This flow was cancelled.");
      return;
    }
    const order: any = await database.collection("orders").findOne({ _id: new ObjectId(flow.orderId) });
    if (!order || order.refund_status === "refunded" || Number(order.charge || 0) <= 0) {
      clearFlow(ctx);
      await ask(ctx, "The order is missing, already refunded, or has no refundable charge. No action was staged.");
      return;
    }
    const summary = `↩️ <b>Confirm atomic order refund</b>\nOrder: <code>${idString(order._id)}</code>\nUser: <code>${escapeHtml(order.user_email || "unknown")}</code>\nAmount: <b>${fmtMoney(order.charge)}</b>\nService: ${escapeHtml(order.service_name || order.service_id || "unknown")}\nReason: ${escapeHtml(text)}`;
    clearFlow(ctx);
    await queueAdminAction(ctx, "order_refund", { order_id: idString(order._id), reason: text }, summary);
    return;
  }

  if (flow.kind === "note") {
    if (text.length < 5 || text.length > 500) return ask(ctx, "Owner note must be 5–500 characters. Try again, or cancel.");
    const user: any = await getUserById(database, flow.userId);
    if (!user) {
      clearFlow(ctx);
      await ask(ctx, "The user no longer exists. This flow was cancelled.");
      return;
    }
    await ensureAdminControlIndexes(database);
    const now = new Date();
    const actor = String(ctx.from?.id || "");
    await Promise.all([
      database.collection("admin_notes").insertOne({ user_id: user._id, note: text, actor_telegram_id: actor, created_at: now }),
      database.collection("admin_audit").insertOne({ action_type: "admin_note_added", actor_telegram_id: actor, subject_user_id: user._id, outcome: "completed", details: { note: text }, created_at: now }),
    ]);
    clearFlow(ctx);
    await render(ctx, `✅ Owner note added for <code>${escapeHtml(user.email || "(pseudonymized account)")}</code>.`, addNavigation([[button("👤 Return to profile", `d:user:${idString(user._id)}`)]], `d:user:${idString(user._id)}`));
    return;
  }

  if (flow.kind === "support") {
    if (text.length < 5 || text.length > 500) return ask(ctx, "Support reason must be 5–500 characters. Try again, or cancel.");
    const user: any = await getUserById(database, flow.userId);
    if (!user) {
      clearFlow(ctx);
      await ask(ctx, "The user no longer exists. This flow was cancelled.");
      return;
    }
    if (user.account_locked === true) {
      clearFlow(ctx);
      await ask(ctx, "Support Access is unavailable while this account is locked. The form was cancelled.");
      return;
    }
    const actorTelegramId = ctx.from?.id;
    if (!actorTelegramId) throw new Error("Owner identity unavailable.");
    const issued = await issueSupportAccessCode(database, { user, actorTelegramId, reason: text });
    try {
      const sent: any = await ctx.reply(
        `👁 <b>Read-only Support Access created</b>\n\nUser: <code>${escapeHtml(user.email || "(pseudonymized account)")}</code>\n` +
        `One-time code: <code>${escapeHtml(issued.rawCode)}</code>\nExchange by: <code>${escapeHtml(fmtDate(issued.expiresAt))}</code>\n` +
        `Website session: <b>15 minutes · read-only</b>\nReason: ${escapeHtml(text)}\n\n` +
        `<i>The code is displayed once. Enter it at the website Support Access screen while signed in as the owner.</i>`,
        { parse_mode: "HTML", reply_markup: homeKeyboard() },
      );
      await database.collection("support_access_codes").updateOne(
        { _id: issued.insertedId },
        { $set: { telegram_chat_id: sent.chat?.id || ctx.chat?.id, telegram_message_id: sent.message_id } },
      );
    } catch (error) {
      await database.collection("support_access_codes").updateOne(
        { _id: issued.insertedId },
        { $set: { invalidated_at: new Date(), invalidation_reason: "telegram_delivery_failed" } },
      ).catch(() => {});
      throw error;
    }
    clearFlow(ctx);
    return;
  }

  if (flow.kind === "reset_password") {
    if (flow.step === "password") {
      // Remove every owner-entered candidate, including invalid values, when Telegram permits it.
      await ctx.deleteMessage().catch(() => {});
      const passwordError = validateCustomTemporaryPassword(text);
      if (passwordError) return ask(ctx, `${escapeHtml(passwordError)}\nTry another value, or cancel this reset.`);
      const protectedPassword = await protectCustomTemporaryPassword(text);
      setFlow(ctx, { ...flow, step: "reason", protectedPassword });
      await ask(ctx, "Password retained only in protected five-minute action state. Now enter the verified recovery reason (5–500 characters). The identity checklist must still be confirmed.");
      return;
    }
    if (text.length < 5 || text.length > 500) return ask(ctx, "Recovery reason must be 5–500 characters. Try again, or cancel.");
    const user: any = await getUserById(database, flow.userId);
    if (!user) {
      clearFlow(ctx);
      await ask(ctx, "The user no longer exists. This reset was cancelled.");
      return;
    }
    const actorTelegramId = ctx.from?.id;
    if (!actorTelegramId) throw new Error("Owner identity unavailable.");
    const { rawActionToken, expiresAt } = await createPasswordResetAction(database, {
      user,
      actorTelegramId,
      reason: text,
      generated: flow.mode === "generated",
      protectedPassword: flow.protectedPassword,
    });
    clearFlow(ctx);
    await ctx.reply(
      `⚠️ <b>Confirm temporary-password reset</b>\n\n` +
      `User: <code>${escapeHtml(user.email || "(pseudonymized account)")}</code>\n` +
      `Mode: <code>${flow.mode === "generated" ? "Generate automatically" : "Owner-selected"}</code>\n` +
      `Lifetime: <code>${temporaryPasswordTtlMinutes()} minutes</code> · Maximum uses: <code>${temporaryPasswordMaxUses()}</code>\n` +
      `Reason: ${escapeHtml(text)}\n\n` +
      `<b>Identity checklist — verify at least two before confirming:</b>\n` +
      `□ Registered email\n□ Recent internal order + target\n□ Recent service/quantity\n□ Deposit amount + UTR/reference\n□ Approximate balance/registration date\n\n` +
      `<i>Confirmation expires at ${escapeHtml(fmtDate(expiresAt))}. Confirming attests that private recovery evidence was checked; existing sessions will be revoked.</i>`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [button("✅ Confirm reset", `pwdreset-confirm:${rawActionToken}`), button("✖ Cancel", `pwdreset-cancel:${rawActionToken}`)],
          [button("🏠 Dashboard", "d:home")],
        ] },
      },
    );
    return;
  }

  if (flow.kind === "settleupi") {
    if (flow.step === "memo") {
      const memo = text.toUpperCase();
      if (!/^SUP[A-Z0-9]{5}$/.test(memo)) return ask(ctx, "Memo must be exactly `SUP` plus five letters or digits. Try again, or cancel.");
      const transaction: any = await database.collection("transactions").findOne({ memo, method: "FAMPAY_UPI", status: { $in: ["pending", "expired"] } });
      if (!transaction) return ask(ctx, "No pending or expired Direct UPI request has that memo. Enter another memo, or cancel.");
      const expectedAmountPaise = Math.round(Number(transaction.amount || 0) * 100);
      setFlow(ctx, {
        ...flow, step: "amount", memo, pendingId: idString(transaction._id), userId: idString(transaction.user_id),
        userEmail: String(transaction.user_email || "unknown"), expectedAmountPaise,
      });
      await ask(ctx, `Memo <code>${escapeHtml(memo)}</code> belongs to <code>${escapeHtml(transaction.user_email || "unknown")}</code> for <b>${fmtMoney(transaction.amount)}</b>. Enter the exact receipt amount.`);
      return;
    }
    if (flow.step === "amount") {
      const amountPaise = parseAmountPaise(text);
      if (!amountPaise) return ask(ctx, "Enter the exact positive receipt amount with no more than two decimal places.");
      if (amountPaise !== flow.expectedAmountPaise) return ask(ctx, `That amount does not match the stored request (${fmtMoney((flow.expectedAmountPaise || 0) / 100)}). Recheck the receipt and try again.`);
      setFlow(ctx, { ...flow, step: "utr", amountPaise });
      await ask(ctx, "Enter the exact 12-digit UTR/reference from the trusted incoming receipt.");
      return;
    }
    if (flow.step === "utr") {
      const utr = text.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      if (!/^\d{12}$/.test(utr)) return ask(ctx, "UTR/reference must be exactly 12 digits. Try again, or cancel.");
      setFlow(ctx, { ...flow, step: "txid", utr });
      await ask(ctx, "Enter the exact FamApp transaction ID (8–40 letters/digits).");
      return;
    }
    if (flow.step === "txid") {
      const transactionId = text.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      if (!/^[A-Z0-9]{8,40}$/.test(transactionId)) return ask(ctx, "Transaction ID must be 8–40 letters/digits. Try again, or cancel.");
      setFlow(ctx, { ...flow, step: "reason", transactionId });
      await ask(ctx, "Enter the exact operational reason (5–500 characters). Only use this for a trusted incoming receipt verified outside Telegram.");
      return;
    }
    if (text.length < 5 || text.length > 500) return ask(ctx, "Reason must be 5–500 characters. Try again, or cancel.");
    const pending: any = flow.pendingId && isObjectId(flow.pendingId)
      ? await database.collection("transactions").findOne({ _id: new ObjectId(flow.pendingId), memo: flow.memo, method: "FAMPAY_UPI", status: { $in: ["pending", "expired"] } })
      : null;
    if (!pending || Math.round(Number(pending.amount || 0) * 100) !== flow.amountPaise) {
      clearFlow(ctx);
      await ask(ctx, "The Direct UPI request changed or is no longer eligible. No action was staged.");
      return;
    }
    const summary = [
      "🧾 <b>Confirm Direct UPI reconciliation</b>",
      `User: <code>${escapeHtml(pending.user_email || "unknown")}</code>`,
      `Amount: <b>${fmtMoney((flow.amountPaise || 0) / 100)}</b> · Memo: <code>${escapeHtml(flow.memo || "")}</code>`,
      `UTR: <code>${escapeHtml(flow.utr || "")}</code> · TxID: <code>${escapeHtml(flow.transactionId || "")}</code>`,
      `Reason: ${escapeHtml(text)}`,
      "<i>Use only after visually confirming the trusted incoming receipt.</i>",
    ].join("\n");
    clearFlow(ctx);
    await queueAdminAction(ctx, "direct_upi_reconcile", {
      pending_id: idString(pending._id), user_id: idString(pending.user_id), amount_paise: flow.amountPaise,
      memo: flow.memo, utr: flow.utr, transaction_id: flow.transactionId, reason: text,
    }, summary);
    return;
  }
}

async function handleDashboardAction(ctx: any, data: string) {
  if (data === "d:noop") return;
  if (data === "d:home") {
    clearFlow(ctx);
    return renderHome(ctx);
  }
  if (data === "d:wizard:cancel") {
    clearFlow(ctx);
    return render(ctx, "<b>Form cancelled.</b> No action was staged.", homeKeyboard());
  }
  if (data === "d:overview") return renderOverview(ctx);
  if (data === "d:users") return renderUsers(ctx, 0);
  if (data.startsWith("d:users:")) return renderUsers(ctx, toPage(data.split(":")[2]));
  if (data === "d:usersearch") return startUserSearch(ctx);
  if (data.startsWith("d:user:")) {
    const parts = data.split(":");
    const userId = parts[2];
    const source = parts[3];
    const sourceValue = parts[4];
    let back = "d:users:0";
    let refresh = `d:user:${userId}`;
    if (source === "u") {
      const page = toPage(sourceValue);
      back = `d:users:${page}`;
      refresh = `d:user:${userId}:u:${page}`;
    } else if (source === "sf") {
      const page = toPage(sourceValue);
      back = `d:security:flagged:${page}`;
      refresh = `d:user:${userId}:sf:${page}`;
    } else if (source === "se") {
      const page = toPage(sourceValue);
      back = `d:security:events:${page}`;
      refresh = `d:user:${userId}:se:${page}`;
    } else if ((source === "or" || source === "of") && isObjectId(sourceValue)) {
      const page = toPage(parts[5]);
      const mode = source === "of" ? "f" : "r";
      back = `d:order:${sourceValue}:${mode}:${page}`;
      refresh = `d:user:${userId}:${source}:${sourceValue}:${page}`;
    } else if (source === "ou" && isObjectId(parts[5])) {
      const page = toPage(sourceValue);
      back = `d:order:${parts[5]}:u:${userId}:${page}`;
      refresh = `d:user:${userId}:ou:${page}:${parts[5]}`;
    } else if (source === "tu" && isObjectId(parts[5])) {
      const page = toPage(sourceValue);
      back = `d:txn:${parts[5]}:u:${userId}:${page}`;
      refresh = `d:user:${userId}:tu:${page}:${parts[5]}`;
    } else if (source === "tp" && isObjectId(sourceValue)) {
      const page = toPage(parts[5]);
      back = `d:txn:${sourceValue}:p:${page}`;
      refresh = `d:user:${userId}:tp:${sourceValue}:${page}`;
    } else if (source === "th" && isObjectId(sourceValue)) {
      const page = toPage(parts[5]);
      back = `d:txn:${sourceValue}:h:${page}`;
      refresh = `d:user:${userId}:th:${sourceValue}:${page}`;
    } else if (source === "tm" && /^SUP[A-Z0-9]{5}$/i.test(sourceValue || "")) {
      const memo = String(sourceValue).toUpperCase();
      back = `d:memo:${memo}`;
      refresh = `d:user:${userId}:tm:${memo}`;
    }
    return renderUser(ctx, userId, back, refresh);
  }
  if (data.startsWith("d:records:")) {
    const [, , kindRaw, userId, pageRaw] = data.split(":");
    if (!["orders", "deposits", "wallet", "events", "notes"].includes(kindRaw)) return;
    return renderUserRecords(ctx, kindRaw as RecordKind, userId, toPage(pageRaw));
  }
  if (data.startsWith("d:orders:")) {
    const [, , mode, pageRaw] = data.split(":");
    if (mode !== "recent" && mode !== "failed") return;
    return renderOrders(ctx, mode as OrderMode, toPage(pageRaw));
  }
  if (data.startsWith("d:order:")) {
    const [, , orderId, originType, a, b] = data.split(":");
    const origin = originType === "u" ? ["u", a, b] : [originType, a];
    return renderOrder(ctx, orderId, origin, orderBack(origin));
  }
  if (data.startsWith("d:refund:")) {
    const orderId = data.split(":")[2];
    if (!isObjectId(orderId)) return;
    const order: any = await (await getDatabase()).collection("orders").findOne({ _id: new ObjectId(orderId) });
    if (!order || order.refund_status === "refunded" || Number(order.charge || 0) <= 0) {
      return render(ctx, "<b>Refund unavailable.</b> This order is missing, already refunded, or has no refundable amount.", addNavigation([], "d:orders:failed:0"));
    }
    return beginFlow(ctx, { kind: "refund", orderId }, `↩️ <b>Stage reviewed refund</b>\nOrder <code>${idString(order._id)}</code> · ${fmtMoney(order.charge)} · ${escapeHtml(order.service_name || order.service_id || "service")}\nEnter the exact review reason (5–500 characters).`);
  }
  if (data === "d:payments") return renderPayments(ctx);
  if (data.startsWith("d:pending:")) return renderPending(ctx, toPage(data.split(":")[2]));
  if (data.startsWith("d:payments:history:")) return renderTransactionHistory(ctx, toPage(data.split(":")[3]));
  if (data.startsWith("d:txn:")) {
    const parts = data.split(":");
    return renderTransaction(ctx, parts[2], parts.slice(3));
  }
  if (data === "d:memosearch") return beginFlow(ctx, { kind: "memo_search" }, "🔍 <b>Look up a Direct UPI memo</b>\nEnter the exact `SUP` plus five-character memo.");
  if (data.startsWith("d:memo:")) return renderMemo(ctx, data.split(":")[2]);
  if (data === "d:reconcile:start") return startReconcileFlow(ctx);
  if (data.startsWith("d:reconcile:txn:")) return startReconcileFlow(ctx, data.split(":")[3]);
  if (data.startsWith("d:reconciliations:")) return renderReconciliations(ctx, toPage(data.split(":")[2]));
  if (data.startsWith("d:reconciliation:")) {
    const parts = data.split(":");
    return renderReconciliation(ctx, parts[2], toPage(parts[3]));
  }
  if (data === "d:security") return renderSecurity(ctx);
  if (data.startsWith("d:security:flagged:")) return renderFlaggedUsers(ctx, toPage(data.split(":")[3]));
  if (data.startsWith("d:security:events:")) return renderSecurityEvents(ctx, toPage(data.split(":")[3]));
  if (data.startsWith("d:controls:")) return renderControls(ctx, data.split(":")[2]);
  if (data.startsWith("d:control:")) {
    const [, , userId, actionRaw] = data.split(":");
    const actions: ControlAction[] = ["account_lock", "account_unlock", "ordering_hold", "ordering_release", "payment_hold", "payment_release"];
    if (!actions.includes(actionRaw as ControlAction) || !isObjectId(userId)) return;
    return beginFlow(ctx, { kind: "control", userId, action: actionRaw as ControlAction }, `🛡 Enter the reason for <b>${escapeHtml(actionRaw.replace(/_/g, " "))}</b> (5–500 characters).`);
  }
  if (data.startsWith("d:money:")) {
    const [, , userId, actionRaw] = data.split(":");
    if (!isObjectId(userId) || !["wallet_credit", "wallet_debit"].includes(actionRaw)) return;
    return startMoneyFlow(ctx, userId, actionRaw as MoneyAction);
  }
  if (data.startsWith("d:keys:")) {
    const [, , userId, pageRaw] = data.split(":");
    return renderKeys(ctx, userId, toPage(pageRaw));
  }
  if (data.startsWith("d:key:")) {
    const [, , keyId, userId, pageRaw] = data.split(":");
    return renderKey(ctx, keyId, userId, toPage(pageRaw));
  }
  if (data.startsWith("d:key-action:")) {
    const [, , keyId, actionRaw] = data.split(":");
    const actions: KeyAction[] = ["api_pause", "api_resume", "api_archive", "api_reissue_required"];
    if (!isObjectId(keyId) || !actions.includes(actionRaw as KeyAction)) return;
    return beginFlow(ctx, { kind: "key", keyId, action: actionRaw as KeyAction }, `🔑 Enter the reason for <b>${escapeHtml(actionRaw.replace("api_", "").replace(/_/g, " "))}</b> (5–500 characters).`);
  }
  if (data.startsWith("d:sessions:")) {
    const [, , userId, pageRaw] = data.split(":");
    return renderSessions(ctx, userId, toPage(pageRaw));
  }
  if (data.startsWith("d:recovery:")) return renderRecovery(ctx, data.split(":")[2]);
  if (data.startsWith("d:reset-mode:")) {
    const [, , userId, modeRaw] = data.split(":");
    if (!isObjectId(userId) || !["generated", "owner_selected"].includes(modeRaw)) return;
    const user: any = await getUserById(await getDatabase(), userId);
    if (!user) return render(ctx, "<b>User not found.</b>", addNavigation([], "d:users:0"));
    const mode = modeRaw as "generated" | "owner_selected";
    if (mode === "generated") {
      return beginFlow(ctx, { kind: "reset_password", userId, mode, step: "reason" }, `🔐 <b>Temporary-password reset</b> for <code>${escapeHtml(user.email || "(pseudonymized)")}</code>.\nEnter the verified recovery reason (5–500 characters).`);
    }
    return beginFlow(ctx, { kind: "reset_password", userId, mode, step: "password" }, `🔐 <b>Owner-selected temporary password</b> for <code>${escapeHtml(user.email || "(pseudonymized)")}</code>.\nEnter 10–128 characters using at least three character categories. This input will be removed from the chat when possible, protected in short-lived state, and shown only after confirmation.`);
  }
  if (data.startsWith("d:support:")) {
    const userId = data.split(":")[2];
    if (!isObjectId(userId)) return;
    const user: any = await getUserById(await getDatabase(), userId);
    if (!user) return render(ctx, "<b>User not found.</b>", addNavigation([], "d:users:0"));
    if (user.account_locked === true) return render(ctx, "Support Access is unavailable while this account is locked.", addNavigation([[button("🛡 Controls", `d:controls:${userId}`)], [button("👤 User profile", `d:user:${userId}`)]], `d:recovery:${userId}`));
    return beginFlow(ctx, { kind: "support", userId }, `👁 <b>Read-only Support Access</b> for <code>${escapeHtml(user.email || "(pseudonymized)")}</code>.\nEnter the bounded operational reason (5–500 characters). The one-time code will be displayed once.`);
  }
  if (data.startsWith("d:note:")) {
    const userId = data.split(":")[2];
    if (!isObjectId(userId)) return;
    const user: any = await getUserById(await getDatabase(), userId);
    if (!user) return render(ctx, "<b>User not found.</b>", addNavigation([], "d:users:0"));
    return beginFlow(ctx, { kind: "note", userId }, `📝 Add an audited owner note for <code>${escapeHtml(user.email || "(pseudonymized)")}</code>.\nEnter 5–500 characters. Never include credentials or unnecessary personal data.`);
  }
  if (data.startsWith("d:review-toggle:")) {
    const [, , reviewId, expectedStatus, pageRaw] = data.split(":");
    if (!isObjectId(reviewId) || !["approved", "hidden"].includes(expectedStatus)) return;
    const database = await getDatabase();
    const reviewFilter: any = { _id: new ObjectId(reviewId), seed: { $ne: true } };
    reviewFilter.status = expectedStatus === "hidden" ? "hidden" : { $ne: "hidden" };
    const review: any = await database.collection("reviews").findOne(reviewFilter);
    if (!review) return renderReviews(ctx, toPage(pageRaw), "Review state changed or the record is unavailable; list refreshed.");
    const nextStatus = expectedStatus === "hidden" ? "approved" : "hidden";
    const client = getMongoClient();
    if (!client) throw new Error("Database client unavailable");
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        const updated = await database.collection("reviews").updateOne(reviewFilter, {
          $set: { status: nextStatus, moderated_at: new Date(), moderated_via: "telegram_bot" },
        }, { session });
        if (updated.modifiedCount !== 1) throw new Error("REVIEW_STATE_CHANGED");
        await database.collection("admin_audit").insertOne({
          action_type: "review_moderation", actor_telegram_id: String(ctx.from?.id),
          outcome: "completed", details: { review_id: review._id, status: nextStatus }, created_at: new Date(),
        }, { session });
      });
    } catch (error: any) {
      if (error?.message !== "REVIEW_STATE_CHANGED") throw error;
      return renderReviews(ctx, toPage(pageRaw), "Review state changed; no second toggle was applied.");
    } finally {
      await session.endSession();
    }
    return renderReviews(ctx, toPage(pageRaw), nextStatus === "hidden" ? "Review hidden from the site." : "Review restored on the site.");
  }
  if (data.startsWith("d:reviews:")) return renderReviews(ctx, toPage(data.split(":")[2]));
  if (data === "d:workers") return renderWorkers(ctx);
  if (data === "d:commands") return renderCommandReference(ctx);
  if (data === "d:close") {
    clearFlow(ctx);
    try { await ctx.deleteMessage(); } catch {}
    return;
  }
}

export function registerAdminDashboard(bot: Telegraf<any>) {
  // A new navigation action or slash command must not leave a stale text prompt
  // armed; otherwise unrelated future text could be consumed by the old wizard.
  bot.use(async (ctx: any, next: () => Promise<void>) => {
    const key = flowKey(ctx);
    if (activeFlows.has(key)) {
      const callbackData = String((ctx.callbackQuery as any)?.data || "");
      if (ctx.callbackQuery && callbackData !== "d:home" && callbackData !== "d:wizard:cancel") clearFlow(ctx);
      const messageText = String(ctx.message?.text || "").trim();
      if (messageText.startsWith("/") && !/^\/cancel(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(messageText)) clearFlow(ctx);
    }
    return next();
  });

  bot.command(["start", "help", "menu"], async (ctx) => {
    clearFlow(ctx);
    await renderHome(ctx);
  });

  bot.command("cancel", async (ctx) => {
    const existing = getFlow(ctx);
    if (!existing) return ctx.reply("No active dashboard form to cancel. Use /menu to open the dashboard.");
    clearFlow(ctx);
    return ctx.reply("Form cancelled. No action was staged.", { reply_markup: homeKeyboard() });
  });

  // Keep already-sent /user profile keyboards working by remapping their older
  // command-guidance callbacks into the same navigable dashboard screens.
  bot.action(/^user-sessions:([a-f0-9]{24})$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    return renderSessions(ctx, ctx.match[1], 0);
  });
  bot.action(/^user-support:([a-f0-9]{24})$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    return handleDashboardAction(ctx, `d:support:${ctx.match[1]}`);
  });
  bot.action(/^user-controls:([a-f0-9]{24})$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    return renderControls(ctx, ctx.match[1]);
  });
  bot.action(/^user-keys:([a-f0-9]{24})$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    return renderKeys(ctx, ctx.match[1], 0);
  });
  bot.action(/^user-records:([a-f0-9]{24})$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    return renderUser(ctx, ctx.match[1]);
  });

  bot.action(/^d:/, async (ctx) => {
    const data = String((ctx.callbackQuery as any)?.data || "");
    await ctx.answerCbQuery().catch(() => {});
    try {
      await handleDashboardAction(ctx, data);
    } catch (error: any) {
      console.error("[AdminDashboard] Screen action failed:", error?.name || "Error");
      await render(ctx, "<b>Could not complete that screen.</b> Refresh or return to the dashboard. No unconfirmed sensitive action was executed.", homeKeyboard()).catch(() => {});
    }
  });

  // Route older menu buttons into the new dashboard instead of leaving stale guidance screens.
  bot.action(/^menu:(overview|users|orders|payments|security|reviews|close)$/, async (ctx) => {
    const section = ctx.match[1];
    await ctx.answerCbQuery().catch(() => {});
    const routes: Record<string, string> = {
      overview: "d:overview", users: "d:users:0", orders: "d:orders:recent:0", payments: "d:payments",
      security: "d:security", reviews: "d:reviews:0",
    };
    if (section === "close") {
      try { await ctx.deleteMessage(); } catch {}
      return;
    }
    return handleDashboardAction(ctx, routes[section]);
  });

  bot.on("text", async (ctx: any, next: () => Promise<void>) => {
    const messageText = String(ctx.message?.text || "");
    // Leave all slash commands available, including command-based workflows.
    if (!messageText || messageText.startsWith("/")) return next();
    const entry = getFlow(ctx);
    if (!entry) return next();
    try {
      await processFlowInput(ctx, entry.flow, messageText);
    } catch (error: any) {
      console.error("[AdminDashboard] Form step failed:", error?.name || "Error");
      if (activeFlows.has(flowKey(ctx))) {
        await ask(ctx, "Could not complete that step safely. The form is still active; recheck the value, retry, or cancel.").catch(() => {});
      } else {
        await ctx.reply("This workflow ended before a reliable result could be shown. Check the relevant record before retrying; no automatic retry was attempted.", { reply_markup: homeKeyboard() }).catch(() => {});
      }
    }
  });
}
