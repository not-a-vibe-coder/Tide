# Tide

A Telegram bot that spots Sui and Solana tokens gaining momentum, tracks how your own trades are doing, and suggests how much to risk based on your budget and your track record. Everything it learns about you is stored on **Walrus Memory**, so its alerts and sizing change as it gets to know you.

Built for the [Walrus × Tatum Total Recall](https://recall-tatum-walrus.vercel.app/) hackathon, Markets & Sports Prediction track.

> Not financial advice. Tide suggests a risk ceiling, never a trade. It only reads public chain data and never asks for keys or signatures.

## How it works

1. **Start:** send `/start` and paste your Sui or Solana address (or both). Tide saves them and never asks again.
2. **Budget:** Tide reads your cash across wallets (SUI, SOL, USDC, USDT) and proposes a weekly trading budget (10% of it). You confirm or pick your own.
3. **Buys:** every 30 minutes Tide compares your balances with the last snapshot. A new token in your wallet is a buy, and Tide asks one question: *why did you buy it?*
4. **Holdings:** `/holdings` and a 9am digest show gain or loss since each buy, next to the reason you gave. If you bought for volume and volume has dropped 30%+, Tide tells you.
5. **Spike alerts:** every 5 minutes Tide scans trending and new pools on Sui and Solana (Solana needs at least $50k liquidity and $50k hourly volume, since it's far busier). A pool whose last hour is 3× its average hour, or whose price (and market cap) jumped 20%+ in an hour, triggers an alert with a risk check and a suggested max size.
6. **Fresh launches (opt-in):** `/launches on` pings you when a token launches on Sui or Solana and, within its first hour, already has real liquidity and buyers (Sui: $5k and 10 buys, Solana: $20k and 30 buys). At most one per chain per scan and six a day. Tide sees launches once they hit a DEX, so it's not a sniper.
7. **Feedback:** tap **Bought**, **Skipped** or **Not for me**. 24 hours later Tide records how the token did. That outcome feeds your track record.
8. **Ask about any token:** "why shouldn't i buy $WIF?", "thoughts on scoop", or paste a Sui coin type or Solana mint. Tide looks it up live (price, market cap, liquidity, volume, pool age, buy/sell pressure, its own risk check), gives you the red flags first, then what's genuinely good, then your max size by your own rules. It never predicts prices or tells you to buy or sell.
9. **What's leading:** `/top`, or ask "top 5 on solana right now". Tide lists the top tokens on each chain by 24h volume with price, 24h change, volume, market cap (or FDV, labelled) and pool age. `/top new`, or "top tokens launched in the last 24 hours", keeps only fresh launches. Pools under $50k liquidity on Solana or $10k on Sui are left out (that's where the fake +1,000,000% moves live), as are SUI, SOL and stablecoins. Follow-ups like "give me their mc" use the list you just saw.
10. **Just talk to it:** ask anything in plain words ("how's scoop doing?", "should i go bigger on this one?", or in pidgin). Tide answers like a friend texting, using your real budget, positions, buy reasons and track record, plus memories recalled from Walrus.

### Voice

Tide talks like [Jasmine](https://github.com/not-a-vibe-coder/Jasmine): lowercase, warm, quietly funny, uses your name, no dashes as pauses, no filler like "great question", and it mirrors your language. Free-text replies go through the same model chain as Jasmine (Groq's Qwen and GPT-OSS, then Gemini Flash) with reasoning hidden. The model only sees numbers Tide has computed or stored, so it can't invent a price, and it never tells anyone to buy or sell. Alerts and reports stay template-based so their numbers are always exact. Without an AI key, everything still works with the built-in messages.

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

**Market history backfill:** a new user has no track record, so Tide learns from the past first. It replays its own spike and launch rules over the last week of real hourly candles (GeckoTerminal OHLCV) for about 25 pools per chain, trending, recently launched and top-volume, so the history isn't only survivors, and records what each signal did over the next 24 hours. These go to the shared `tide-tokens` namespace on Walrus, marked as history, with stable IDs so re-runs never double-count. Until someone has 5 results of their own, their track record starts from this history, softened halfway toward neutral, and every alert says so. It runs a minute after startup when shared memory is thin, then daily at 04:17 Lagos time; `/backfill` (admin) runs it on demand.

**Wipe test:** `/rebuild` (admin only) deletes the local cache and replays every event from Walrus Memory. Budgets, positions, reasons, mutes and track records all come back.

**Tatum Sui gRPC** (`sui-mainnet-grpc.gateway.tatum.io`, native gRPC over HTTP/2) reads Sui balances and coin metadata, falling back to Tatum's Sui JSON-RPC. **Tatum Solana RPC** (`solana-mainnet.gateway.tatum.io`) reads SOL plus every SPL and Token-2022 balance, and tells token mints apart from wallets. Tatum's free plan blocks some Solana methods (`getBalance` is paid-only), so each call tries Tatum first and only a refused method goes to Solana's public RPC (`SOLANA_FALLBACK_RPC_URL`); `/doctor` shows which endpoint served each one.

**GeckoTerminal** (free, no key) provides pool volume, price, market cap and liquidity. Tatum doesn't offer token market data for Sui. Calls are queued, cached for a minute and retried on rate limits.

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
| `TATUM_API_KEY` | [dashboard.tatum.io](https://dashboard.tatum.io/), Sui Mainnet |
| `GROQ_API_KEY` (optional) | [console.groq.com/keys](https://console.groq.com/keys), free |
| `GEMINI_API_KEY` (optional) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey), free |

Then check every connection, and start:

```bash
npm run doctor            # optional: pass a Sui address to test reads against it
npm run dev               # local, with reload
npm run build && npm start
```

No Walrus keys yet? Set `MEMWAL_DRY_RUN=true` to run without writes.

## Commands

You don't need them. Plain words work for every setting and action, in English or pidgin: "turn on launch alerts", "only solana alerts", "pause alerts", "set my budget to $50", "use 20% per alert", "show my bags", "check my wallet", "what's pumping", "what do you remember about me". These are carried out directly, not guessed by the AI. The slash commands below do the same things.


| Command | What it does |
| --- | --- |
| `/start` | Onboarding, or your status |
| `/wallet <address>` | Add or change a Sui (0x…) or Solana wallet |
| `/budget 30` | Weekly budget in USD |
| `/share 25` | % of remaining budget per alert |
| `/holdings` | Positions, P&L and your reasons |
| `/check` | Check your wallet for new buys now |
| `/scan` | Scan Sui and Solana for spikes now |
| `/top [sui\|solana] [new]` | Top 5 tokens by 24h volume on each chain; `new` = launched in the last 24h |
| `/alerts on\|off\|reset` | Pause alerts or unmute token classes |
| `/alerts sui\|solana\|both` | Choose which chains you get alerts for |
| `/launches on\|off` | Alerts for brand-new token launches (off by default) |
| `/memory` | What Tide remembers, plus Walrus write counts |
| `/doctor` | Check Telegram, Tatum, GeckoTerminal and a real Walrus write (admin only; non-admins see their Telegram ID) |
| `/backfill` | Replay a week of market history into shared memory (admin only) |
| `/rebuild` | Wipe test (admin only) |

### In groups

Add @usetidebot to a group and it says hello. It only answers when someone calls it by name (`hey tide, thoughts on $WIF?`), tags it, or replies to one of its messages, so it never floods the chat. Token reads and top lists work in the group. Anything personal (wallets, budgets, bags, alerts) gets a button to continue in private, and personal alerts always go to the private chat. Tags and replies work with Telegram's default privacy mode. For "hey tide" to work, turn privacy mode off in BotFather (`/setprivacy` → Disable) and re-add the bot to the group, or make it a group admin.

## Deploy

Tide uses long polling, so it runs on any always-on Node host. On Render's free web service it pings its own public URL (`RENDER_EXTERNAL_URL`, set by Render) every 10 minutes, because the free plan sleeps after 15 minutes without inbound traffic and Telegram polling doesn't count. Set `KEEP_AWAKE_URL` to override. On Railway or Render: create a service from this repo, set the build command to `npm install && npm run build`, the start command to `npm start`, add the `.env` variables, and attach a persistent volume at `./data` for the cache. If the volume is lost, `/rebuild` restores it from Walrus Memory.

## Development

```bash
npm test         # unit tests + end-to-end flow against the MemWal SDK mock
npm run typecheck
```

```
src/
  core/      pure logic: spike rules, risk, sizing, buy detection
  memory/    events, SQLite cache, Walrus Memory client and rebuild
  chain/     Tatum Sui gRPC and Solana RPC readers
  market/    GeckoTerminal client
  ai/        Jasmine-style persona, Groq → Gemini chain, reply cleanup
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
