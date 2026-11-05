# Tide

A Telegram bot that spots Sui tokens gaining momentum, tracks how your own trades are doing, and suggests how much to risk based on your budget and your track record. Everything it learns about you is stored on **Walrus Memory**, so its alerts and sizing change as it gets to know you.

Built for the [Walrus × Tatum Total Recall](https://recall-tatum-walrus.vercel.app/) hackathon, Markets & Sports Prediction track.

> Not financial advice. Tide suggests a risk ceiling, never a trade. It only reads public chain data and never asks for keys or signatures.

## How it works

1. **Start:** send `/start` and paste your Sui address. Tide saves it and never asks again.
2. **Budget:** Tide reads your SUI and USDC balance and proposes a weekly trading budget (10% of it). You confirm or pick your own.
3. **Buys:** every 30 minutes Tide compares your balances with the last snapshot. A new token in your wallet is a buy, and Tide asks one question: *why did you buy it?*
4. **Holdings:** `/holdings` and a 9am digest show gain or loss since each buy, next to the reason you gave. If you bought for volume and volume has dropped 30%+, Tide tells you.
5. **Spike alerts:** every 5 minutes Tide scans trending and new Sui pools. A pool whose last hour is 3× its average hour, or whose price (and market cap) jumped 20%+ in an hour, triggers an alert with a risk check and a suggested max size.
6. **Feedback:** tap **Bought**, **Skipped** or **Not for me**. 24 hours later Tide records how the token did. That outcome feeds your track record.

### The sizing formula

```
max size = budget left this week × base share × track record (h) × token risk (r)
```

| Input | Source | Range |
| --- | --- | --- |
| Budget left | Your weekly budget minus buys detected since Monday (Lagos time) | $0+ |
| Base share | Default 25%, change with `/share` | 5–50% |
| Track record h | Your last 10 resolved alerts of this token class. 1.0 until you have 5. | 0.5–1.2 |
| Token risk r | Liquidity, pool age, sell pressure | 0.25–1.0 |

Example: $30 left × 25% × 0.8 × 0.5 = **$3**. Every alert shows all four numbers.

## Where Walrus Memory and Tatum come in

**Walrus Memory is the system of record.** Every change is an event (`profile_set`, `buy_detected`, `buy_reason`, `alert_sent`, `alert_action`, `alert_outcome`, `preference`, `position_closed`, `token_outcome`). Each event is applied to a local SQLite cache and written to Walrus Memory Mainnet in the background. A write is only marked stored once Walrus confirms the job.

- Per-user namespace: `tide-user-<telegram id>`
- Shared namespace: `tide-tokens`, holding token outcomes from every user, so each alert can say how that kind of token has done for everyone.

Three learning loops read from it:

1. **Track record:** losing alerts shrink future sizes; winning ones grow them.
2. **Taste:** *Not for me* mutes that token class (brand-new pools or established tokens).
3. **Thesis check:** your stored reason for each buy is compared with live data.

**Wipe test:** `/rebuild` (admin only) deletes the local cache and replays every event from Walrus Memory. Budgets, positions, reasons, mutes and track records all come back.

**Tatum Sui gRPC** (`sui-mainnet-grpc.gateway.tatum.io`) reads wallet balances and coin metadata. Sui has deprecated JSON-RPC, so Tide uses gRPC.

**GeckoTerminal** (free, no key) provides pool volume, price, market cap and liquidity. Tatum doesn't offer token market data for Sui.

## Setup

Requires Node 20+.

```bash
git clone https://github.com/not-a-vibe-coder/tide.git
cd tide
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Where to get it |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Message [@BotFather](https://t.me/BotFather), `/newbot` |
| `ADMIN_TELEGRAM_IDS` | Your Telegram user ID (message [@userinfobot](https://t.me/userinfobot)) |
| `MEMWAL_PRIVATE_KEY`, `MEMWAL_ACCOUNT_ID` | [memory.walrus.xyz/dashboard](https://memory.walrus.xyz/dashboard): create an agent and a delegate key. The delegate's public key is your `MEMWAL_AGENT_ID` for the submission form. |
| `TATUM_API_KEY` | [dashboard.tatum.io](https://dashboard.tatum.io/) |

Then check every connection, and start:

```bash
npm run doctor            # optional: pass a Sui address to test reads against it
npm run dev               # local, with reload
npm run build && npm start
```

No Walrus keys yet? Set `MEMWAL_DRY_RUN=true` to run without writes.

## Commands

| Command | What it does |
| --- | --- |
| `/start` | Onboarding, or your status |
| `/wallet 0x…` | Set or change the tracked address |
| `/budget 30` | Weekly budget in USD |
| `/share 25` | % of remaining budget per alert |
| `/holdings` | Positions, P&L and your reasons |
| `/check` | Check your wallet for new buys now |
| `/scan` | Scan Sui for spikes now |
| `/alerts on\|off\|reset` | Pause alerts or unmute token classes |
| `/memory` | What Tide remembers, plus Walrus write counts |
| `/doctor` | Check Telegram, Tatum, GeckoTerminal and a real Walrus write (admin only; non-admins see their Telegram ID) |
| `/rebuild` | Wipe test (admin only) |

## Deploy

Tide uses long polling, so it runs on any always-on Node host. On Railway or Render: create a service from this repo, set the build command to `npm install && npm run build`, the start command to `npm start`, add the `.env` variables, and attach a persistent volume at `./data` for the cache. If the volume is lost, `/rebuild` restores it from Walrus Memory.

## Development

```bash
npm test         # unit tests + end-to-end flow against the MemWal SDK mock
npm run typecheck
```

```
src/
  core/      pure logic: spike rules, risk, sizing, buy detection
  memory/    events, SQLite cache, Walrus Memory client and rebuild
  chain/     Tatum Sui gRPC reader
  market/    GeckoTerminal client
  bot/       Telegram handlers and message formatting
  tide.ts    the service tying it together
  index.ts   entry point and scheduled jobs
  doctor.ts  connection checks
```

## Known limits

- Buys are detected from balance changes, so receiving a token by transfer also counts as a buy. The *why* question lets you skip it.
- Recall returns at most 100 memories per query. Rebuild queries once per event type per namespace, which covers about 100 events of each type per user.
- GeckoTerminal's free API is rate-limited to about 30 calls a minute. Tide spaces its calls about 2 seconds apart.

## License

MIT
