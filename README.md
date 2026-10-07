# SMM UP Telegram Admin Bot and Settlement Worker

> **Runtime:** Railway or another always-on Node.js host
> **Transport:** Telegram Bot API long polling
> **Repository scope:** bot and worker code only
> **Production validation:** required after the first Railway deployment

This private owner service provides SMM UP’s administrative control plane and Direct UPI email-settlement worker. There is no website admin panel.

For the full implemented-state specification, see [`ADMIN_BOT_DEVELOPMENT_PLAN.md`](ADMIN_BOT_DEVELOPMENT_PLAN.md). This repository is the standalone Railway service; keep all real credentials in Railway Variables, never in files.

---

## Deploy on Railway

1. Keep the GitHub repository private and deploy this repository as one Railway service with the repository root as the service root.
2. Railway uses `railway.json` and runs `npm start`; do not configure a webhook or a public domain because the bot uses Telegram long polling.
3. Copy every applicable variable name from `.env.example` into Railway **Variables**. Never commit a real `.env`, Telegram token, MongoDB URI, Gmail address/app password or state secret.
4. Use the same production MongoDB database as the website so bot actions, payment records, wallet ledger and sessions remain consistent.
5. Keep `ENABLE_IMAP_WORKER=false` for the first identity/database check. After the bot starts successfully and `getMe` confirms the intended bot, set it to `true` and redeploy to enable the lease-controlled Gmail scanner.
6. Keep `ADMIN_BOT_DISABLE_AUTOSTART=false` in production. Only one bot token should long-poll at a time; stop any older Railway service before enabling this one.
7. Validate `/start`, `/stats`, `/scan`, one cancelled confirmation and one staging settlement before treating the deployment as production-ready.

Recommended Railway service settings:

- Build command: automatic (`npm ci` through Nixpacks)
- Start command: `npm start`
- Keep `tsx` in `dependencies` (not only `devDependencies`) and commit the matching lockfile: `npm start` executes `tsx bot.ts`, and production installs may omit development dependencies.
- Restart policy: on failure, maximum 10 retries
- Health domain: none required; monitor process logs plus the `system_health` MongoDB records

---

## Source layout

`bot.ts` is intentionally a thin composition and process-lifecycle entry point. The service remains one Node.js process and one Railway deployment; these modules are code boundaries, not microservices.

| Path | Responsibility |
|---|---|
| `bot.ts` | Validate startup configuration, compose handlers, launch long polling, start both workers and handle process shutdown; re-export the established integration-test surface |
| `src/config.ts` | Environment loading, startup validation and bounded temporary-password policy |
| `src/db/client.ts` | Lazy MongoDB client/database lifecycle |
| `src/db/indexes.ts` | Administrative, payment and idempotency index gate |
| `src/security/` | Telegram HTML escaping, action-token hashing, protected action-state encryption and temporary-password generation |
| `src/domain/pendingActions.ts` | Reason parsing and five-minute actor-bound confirmation staging |
| `src/domain/adminActions.ts` | Confirmed transactional wallet, refund, account, hold and API-key mutations plus audit writes |
| `src/middleware/ownerAuthorization.ts` | Numeric owner authorization for every command and callback |
| `src/callbacks/adminActions.ts` | Generic Confirm/Cancel callback claim and transaction orchestration |
| `src/commands/general.ts` | Help/menu, statistics, recent orders and review moderation |
| `src/commands/users.ts` | User detail, records, sessions and account/key control staging |
| `src/commands/recovery.ts` | Temporary-password and one-time Support Access workflows |
| `src/commands/operations.ts` | Wallet, refund, order/deposit and memo operations |
| `src/ui/reviews.ts` | Review moderation rendering and inline keyboard construction |
| `src/worker/settlement.ts` | Exactly-once Direct UPI settlement transaction |
| `src/worker/paymentScanner.ts` | Bounded IMAP fetch/parsing, exact pending-match checks and settlement invocation |
| `src/worker/paymentRuntime.ts` | `/scan`, process guard, distributed lease, reconciliation, health and 20-second scheduler |
| `src/worker/recoveryStatus.ts` | Temporary-password and Support Access Telegram status synchronization |
| `src/worker/runtime.ts` | Worker composition only; exposes the two scheduler start functions to `bot.ts` |
| `tests/adminActions.integration.ts` | Replica-set transaction, replay, rollback and concurrent-settlement coverage |

Handler registration remains deliberate: owner middleware, generic administrative callbacks, general commands, user controls, recovery, operational commands, then the worker-owned `/scan` command. Preserve this order during future changes unless a reviewed behavior change requires otherwise.

---

## Security model

- Every Telegram message and callback is checked against numeric `TELEGRAM_OWNER_ID`.
- Telegram usernames and chat IDs do not grant authority.
- The bot calls `getMe` before launch and accepts only message/callback update types.
- Pending Telegram updates are dropped at startup.
- Sensitive mutations use an opaque hash-only callback token, actor binding, five-minute expiry, one-time atomic claim and MongoDB transaction.
- A reason of 5–500 characters is mandatory for supported sensitive commands.
- Permanent and temporary passwords are bcrypt hashes at rest.
- A custom temporary password is AES-256-GCM protected only during the five-minute confirmation step.
- Raw API secrets, raw session tokens, cookies, authorization headers and prior passwords are never returned by the bot.
- Support Access uses a separate one-time code and a read-only website session; it is not raw-session impersonation.
- Direct UPI settlement requires exact pending transaction, user, amount, memo and unprocessed payment identifiers.
- A distributed MongoDB lease prevents two Railway replicas from actively scanning/settling together.

The bot is a high-value surface. Protect the owner’s Telegram account with two-step verification and review active Telegram sessions/devices.

---

## Implemented command reference

Use `/start` or `/help` for the inline entry menu. The menu currently routes to command guidance and user-profile controls; not every operation is a fully navigable dashboard screen.

### Read and inspect

| Command | Behavior |
|---|---|
| `/stats` | Platform user/order/deposit and wallet telemetry |
| `/user <email>` | Full owner-authorized user detail plus inline sessions/support/control/key/record buttons |
| `/userorders <email>` | Last 10 orders, including targets and refund state |
| `/deposits <email>` | Last 15 transaction/deposit records |
| `/wallet <email>` | Last 20 wallet-ledger records |
| `/events <email>` | Last 15 security events plus last 10 owner notes |
| `/orders [limit]` | Recent orders; default 5, maximum 20 |
| `/failed` | Last 10 failed/review-required orders |
| `/pending` | Last 10 pending deposits |
| `/checkmemo <memo>` | Exact memo lookup |
| `/settleupi <memo> <amount> <UTR> <TxID> \| reason` | Owner-confirmed exact receipt reconciliation when a provider removed the SUP note |
| `/reviews [limit]` | Buyer-submitted reviews; default 8, maximum 12, with inline hide/show |

### Account and wallet mutations

All commands below require the literal `|` separator and an exact reason.

```text
/credit user@example.com 250 | correction reason
/debit user@example.com 250 | correction reason
/refund <orderObjectId> | reviewed refund reason
/settleupi SUPABCDE 50.00 987654321012 FMPIB1234567890 | trusted incoming receipt verified; provider removed SUP note
/lock user@example.com | security reason
/unlock user@example.com | reviewed release reason
/orderhold user@example.com | hold reason
/orderrelease user@example.com | release reason
/paymenthold user@example.com | payment review reason
/paymentrelease user@example.com | reviewed release reason
/note user@example.com | owner-only note
```

`/credit`, `/debit`, `/refund`, `/settleupi`, account lock/hold commands and key controls create Confirm/Cancel messages. The bot re-reads current database state during confirmation. `/settleupi` requires exact memo, amount, 12-digit UTR and FamApp transaction ID, atomically claims the pending/expired request, records all anti-replay identities and credits once. Cancelled, expired, wrong-owner and replayed callbacks cannot perform the mutation.

`/note` is immediately recorded with an audit record; it does not use the five-minute financial confirmation path.

### API-key controls

First inspect the user with `/user <email>` and open **API Keys** to obtain the internal key ID. Then:

```text
/keypause <keyObjectId> | reason
/keyresume <keyObjectId> | reason
/keyarchive <keyObjectId> | reason
/keyreissue <keyObjectId> | reason
```

- Pause preserves the key secret.
- Archive is permanent and revokes active versions.
- Reissue-required revokes versions; the identity cannot resume until the user rotates securely on the website.
- No new raw API secret is generated or sent through Telegram.

### Recovery and support

```text
/resetpassword user@example.com auto | identity verified and recovery reason
/resetpassword user@example.com <temporary-value> | identity verified and recovery reason
/supportaccess user@example.com | support reason
```

Temporary-password behavior:

- confirm within five minutes;
- default lifetime 180 minutes;
- default maximum uses 2; configuration allows only 1 or 2;
- existing website/support/restricted sessions are revoked as designed;
- temporary login grants only the permanent-password flow;
- Telegram reset message is later edited with use count, remaining uses, completion or expiry.

Support Access behavior:

- code is displayed once and stored hash-only;
- exchange window is five minutes;
- resulting separate website support session lasts 15 minutes;
- actor and subject remain distinct;
- website shows a read-only support banner;
- all mutations remain denied server-side;
- the Telegram message is updated after exchange, exit, revocation or expiry.

### Session controls

Run `/user <email>` and tap **Sessions** or **Revoke All Sessions**. A session-specific revoke has its own confirmation. Global revoke invalidates normal, support and restricted session state and records a security event.

### Worker

| Command | Behavior |
|---|---|
| `/scan` | Attempts the distributed lease, runs an immediate IMAP scan, reconciliation and health update |

The automatic loop runs every 20 seconds on an enabled service. The lease is 180 seconds and is refreshed/acquired in MongoDB. Failed reconciliation items generate owner alerts after repeated attempts. Worker health records heartbeat, holder, last success/error and consecutive failures.

---

## Environment variables

Store values in Railway’s secret-variable system. Never commit `.env`.

```text
TELEGRAM_BOT_TOKEN=             # required; BotFather token
TELEGRAM_OWNER_ID=              # required for any owner action; numeric Telegram user ID
ADMIN_BOT_STATE_SECRET=         # strongly required; independent high-entropy state key
MONGODB_URI=                    # required; transaction-capable Atlas/replica-set URI
MONGODB_DB_NAME=                # preferred bot DB name; must match website environment
DATABASE_NAME=                  # accepted fallback for database name
IMAP_USER=                      # settlement mailbox
IMAP_PASSWORD=                  # mailbox app password
FAMPAY_SENDER_FILTER=           # expected receipt sender
ENABLE_IMAP_WORKER=true         # set false on a bot-only service
TEMP_PASSWORD_TTL_MINUTES=180   # optional, bounded 15–1440
TEMP_PASSWORD_MAX_USES=2        # optional; 1 or 2 only
```

`ADMIN_BOT_STATE_SECRET` currently falls back to derivation from a sufficiently long bot token, but production must configure an independent secret so bot-token rotation does not couple to protected five-minute state.

`ADMIN_BOT_DISABLE_AUTOSTART=true` exists for tests/controlled imports only. Do not set it on the production service.

The worker code uses ImapFlow defaults for host/security and the listed mailbox variables; do not add undocumented IMAP host/port values expecting them to be consumed.

---

## Railway deployment

1. Create a Railway project from the repository.
2. Set the service root directory to the repository root (`.`). `package.json`, `package-lock.json` and `railway.json` are at this repository's root; do not set the root to `admin-bot`.
3. Set the start command to `npm start` if not detected from `package.json`.
4. Add environment values through Railway secrets.
5. Use a separate staging bot token/owner/database/mailbox before production.
6. Deploy one intended service with `ENABLE_IMAP_WORKER=true`.
7. Confirm the startup log identifies the expected bot username and long polling.
8. Confirm critical indexes create successfully.
9. Send `/start` from the owner account.
10. Send a command from a non-owner test account and confirm rejection.
11. Confirm `system_health` heartbeat and `worker_leases` state.
12. Run the staging matrix in the security runbook.

Do not configure a Telegram webhook for this bot token. Webhook-secret validation is not applicable to this long-polling transport.

---

## Local validation

Do not use production secrets or production users for local destructive tests.

```bash
npm ci
npx tsc --noEmit
npm run test:admin-actions
npm audit --omit=dev
```

To start manually with a controlled environment:

```bash
npm start
```

The integration suite uses an ephemeral MongoDB replica set and exercises concurrent wallet/refund/key/control and worker-settlement behavior. It does not prove Telegram, Railway, mailbox or provider production readiness.

---

## Required MongoDB capabilities

- Replica-set transactions.
- Permission to read/write the SMM UP application database.
- Permission to create the required indexes.
- Unique constraints for admin callback hashes, Direct UPI memo/identifier/settlement keys and wallet settlement keys.
- TTL behavior for short-lived action/support/recovery records.

For `processed_transactions`, startup reuses an existing unique single-field identifier index (including legacy non-sparse indexes) instead of requesting a conflicting auto-named sparse index. If no equivalent index exists, it creates an explicitly named sparse unique index. The worker records a per-deposit internal sentinel for absent optional UTR/transaction IDs so legacy non-sparse indexes do not collide on missing values; these sentinels are not treated as receipt identifiers. Do not drop an existing unique index to force startup.

Startup/index failures are release-blocking. Do not remove uniqueness merely to make a deployment start.

---

## Operational checks

### Healthy

- Railway process remains up.
- Expected bot identity is logged.
- Owner commands respond and non-owner commands do not disclose data.
- One worker lease holder is active.
- Heartbeat and last-success timestamps advance.
- Consecutive error count returns to zero after success.
- Pending deposit count and reconciliation queue are explainable.
- Telegram recovery/support status edits complete or retry.

### Stop and investigate

- wrong bot identity;
- unexpected owner ID behavior;
- duplicate wallet settlement;
- more than one active lease holder;
- repeated mailbox authentication errors;
- index creation failure;
- raw credential/token content in logs or Telegram;
- unexplained balance or ledger mismatch;
- confirmation replay performing a second mutation.

---

## Incident and rollback basics

1. Stop the Railway service if authorization or financial behavior is unsafe.
2. Disable `ENABLE_IMAP_WORKER` or stop the worker when settlement safety is uncertain.
3. Revoke the Telegram bot token if exposure is suspected.
4. Rotate `ADMIN_BOT_STATE_SECRET` if protected custom-action state could be exposed.
5. Preserve redacted action, ledger, transaction, lease and deployment IDs.
6. Reconcile committed database mutations; a code rollback cannot undo them.
7. Roll back to the last known-good Railway deployment only after compatibility review.
8. Re-run owner/non-owner, confirmation, lease and settlement smoke tests before resuming.

See the central runbook for severity, communication, backup and evidence procedures.

---

## Secret and privacy prohibitions

Never send, store in audit details, or log:

- readable permanent passwords;
- password hashes;
- raw session tokens or cookies;
- raw reseller API secrets;
- authorization headers;
- bot/provider/database/mailbox secrets;
- complete payment-email bodies;
- UPI PIN, OTP, CVV or banking password;
- private markup values.

Owner-authorized views may show full user email and complete operational account, order and deposit details when required for support.

## Modular runtime contract

`bot.ts` is the composition root. It loads validated configuration, creates shared database/Telegram dependencies, registers middleware and command/callback modules, starts long polling, and coordinates worker shutdown. Domain mutations remain in `src/domain`, authorization in `src/middleware`, secret/action-state handling in `src/security`, persistence/index setup in `src/db`, and payment scanning/settlement in `src/worker`.

The first modularization is intentionally behavior-preserving. Moving code across modules must not change command names, callback payload semantics, owner authorization, confirmation expiry, financial settlement keys, lease behavior or Telegram output boundaries without a separately reviewed behavior change.

## Railway template and startup preflight

Use `.env.example` as the complete Railway variable checklist. Before startup, verify variable presence by name only, confirm the bot identity with Telegram `getMe`, establish MongoDB/index readiness, then start polling and the optional lease-controlled worker. `ADMIN_BOT_DISABLE_AUTOSTART` is test-only and must not accidentally disable the production process.

A healthy process is not enough to prove settlement safety. Test wrong-user denial, stale/replayed callbacks, two-replica lease behavior, exact receipt matching and one-ledger/one-balance convergence in staging.

## Coordination with website audit release `3220567`

The website now supports reauthenticated profile updates, settlement-gated self-erasure, favourites/templates, cancellation requests and safe reorder. The bot remains the exclusive review-moderation surface and the comprehensive owner control plane.

Operational implications:

- tolerate deleted users whose email/username are pseudonymous and whose order target/comment fields are absent;
- show `Cancel requested` and uncertain supplier submissions without implying automatic refund;
- keep review approve/hide/delete callbacks owner-only and audited;
- never store favourites/templates targets—those collections contain only service metadata and optional quantity;
- compare Direct UPI evidence with server-owned configured limits, not copied frontend numbers;
- use immutable IDs for administrative actions even after a username change.

No webhook or website admin panel was introduced. Railway still uses long polling, distributed worker leases and owner-only Telegram authorization.
