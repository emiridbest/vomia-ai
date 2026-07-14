# Vomia — a non-custodial DeFAI agent on Celo

**Agentic Payments & DeFAI Hackathon** (submission window: July 7 – August 3, 2026, 09:00 UTC)

Vomia is an always-on FX & arbitrage agent for Celo tokens, built as an
autonomous on-chain loop. A user logs in with a social account (Web3Auth
MPC — no seed phrase, no server-held key for the user's own funds), opens a
personal on-chain vault, and sets a plain-language rule and risk margin.
From there the agent trades inside that vault — strictly within caps only
the user controls — quoting Mento and Uniswap on every heartbeat, and
executing only when a trade clears the user's profit margin after gas.
Monetization is pure x402: every paid API call settles a real stablecoin
micropayment through Celo's own facilitator.

The one exception to the non-custodial model is the agent's own operator
key, which pays gas and calls a capped `executeSwap` — never a user
withdrawal. `SECURITY.md` documents that design and why it differs from
the original spec (DB-stored user keys).

---

## How this maps to the four hackathon tracks

| Track | Where it lives in this repo |
|---|---|
| **1 — Most Revenue** | Two x402-priced endpoints other agents pay to use: `GET /api/x402/fx-route` ($0.01/call) and `GET /api/x402/check` ($0.001/call). All revenue flows through one rail — x402 — into `X402_PAYOUT_WALLET_ADDRESS`, so every unit of Track 1 revenue is simultaneously a Track 2 payment. |
| **2 — Most x402 Payments** | The `/api/x402/check` endpoint is designed for volume: it's a paid "should I rebalance?" poll that charges whether the answer is yes or no. A modest user base polling every couple of minutes → thousands of genuine settled payments/day. The x402 gate (`lib/x402/gate.ts`) settles through Celo Core Co's hosted facilitator (api.x402.celo.org) — the hackathon's own rail, so every payment is visible to Track 2's metering. Endpoints are priced above the facilitator's ~$0.001/settlement floor ($0.005 and $0.01). |
| **3 — AskBots** | The judge-bot registration is an operational step, not code in this repo — a bot with a Celo wallet, pointed at this same reasoning stack. The `vaultTools` risk-review logic (`lib/goat/tools.ts`) doubles as a scoring rubric for judging other DeFAI submissions. |
| **4 — Aigora Marketplace** | The `fx-route` endpoint is listed as a hireable service via the Aigora intake — it needs nothing from a caller except an x402 payment, which is exactly the shape Aigora worker-agents consume. |

Cross-cutting: every operator-signed trade carries an ERC-8021 Attribution
Tag (`lib/attribution.ts`), so all on-chain activity is verifiably credited
to this project — which is what the hackathon's leaderboard reads.

## Architecture

```
User (social login) ──Web3Auth MPC──► user wallet (key never server-side)
        │ signs: deposits, withdrawals, caps, pause
        ▼
┌───────────────────────────┐   owner-only: withdraw, caps, allow-lists, un-pause
│  AgentVault (one/user,    │◄──────────────────────────────────────────────┐
│  EIP-1167 clone)          │                                               │
│  · token & router         │   operator-only: executeSwap(actionId, ...)   │
│    allow-lists            │◄──────────────┐                               │
│  · per-trade + 24h caps   │               │                               │
│  · slippage floor,        │        ┌──────┴────────┐              ┌───────┴──────┐
│    idempotency, breaker   │        │ Worker loop   │              │  Next.js app │
└──────────┬────────────────┘        │ (scripts/     │              │  chat + dash │
           │ swaps via allow-listed  │  worker.ts)   │              │  + x402 APIs │
           ▼ targets only            │ scan → decide │              └──────────────┘
   Mento Broker / Uniswap v3         │ → execute     │
   (Squid & LiFi: cross-chain        │   within caps │
    funding only, not the hot loop)  └───────────────┘
```

## Running it

```bash
# 1. Contracts
cd contracts
npm install
npx hardhat compile          # (in restricted sandboxes: node scripts/local-compile.js)
npx hardhat test             # 11 tests — all safety properties
cp .env.example .env         # fill DEPLOYER_PRIVATE_KEY + AGENT_OPERATOR_ADDRESS
npm run deploy:alfajores     # deploys to Celo Sepolia testnet — the network this build targets

# 2. Web + worker
cd ../web
npm install
cp .env.example .env.local   # fill everything; NEXT_PUBLIC_NETWORK=testnet first
npm run dev                  # landing / dashboard / chat / x402 APIs
npm run worker               # separate terminal/host: the heartbeat loop
```

Full user flow: open the app → social login (Web3Auth) → "Open your vault"
(one user-signed `factory.createVault(0x0)`) → deposit + set caps
(user-signed `setTokenPolicy` / `setTargetAllowed` calls — the dashboard's
risk panel mirrors these) → un-pause → the worker takes it from there.

## How this addresses the hackathon's headline numbers

**"1000 trades per user per day":** the pipeline supports it — a 60s
heartbeat is ~1,440 scan ticks/day/pair, Celo gas is ~$0.001/tx, and the
vault's caps are user-configurable to allow that count. But the worker
only executes when a trade clears the user's profit margin after gas; it
will not manufacture 1000 losing trades to hit a number, and the agent
says so if asked. What *does* scale to 1000+/day unconditionally is paid
x402 `check` calls, which is why Track 2 is built on those — scan
frequency is unbounded, but profitable executions are market-dependent.

**"0.0001 per trade to the protocol":** deliberately folded into the
x402 per-request pricing rather than implemented as a separate per-trade
transfer, for two reasons: (1) the hosted facilitator charges ~$0.001 per
settlement, so a $0.0001 x402 self-payment per trade would cost 10x what
it moves; (2) a separate operator-to-treasury transfer wouldn't count
toward Track 2 and would read as self-dealing volume on-chain. One rail,
one payout wallet, every payment externally sourced and facilitator-metered.

## Data provenance

Addresses cross-checked against authoritative sources; contracts compiled
with solc 0.8.24, all 11 tests passing:

- All token addresses in `web/lib/tokens.ts` — from docs.celo.org's
  canonical token-contracts page (Mento currencies, USDC, USDT) and
  GoodDollar's own docs (G$)
- Mento Broker `0x777A8255...4CaD` — from docs.mento.org's deployments
  page AND a real executed mainnet `swapIn` tx on CeloScan (two
  independent sources)
- Uniswap SwapRouter02 on Celo `0x5615CDAb...abc4` — CeloScan verified
  source + Uniswap's docs repo
- Uniswap QuoterV2, the Squid integrator ID, and the on-chain attribution
  tag are configured from their respective canonical sources
  (docs.celo.org, docs.squidrouter.com, and this project's own hackathon
  registration)

The `@celo/attribution-tags` package call in `lib/attribution.ts` is a
working ERC-8021 fallback implementation; swapping in the official
package's exact export once confirmed is a drop-in change, not a
redesign.

## Repo layout

```
contracts/            Hardhat: AgentVault + VaultFactory + tests (11 passing)
web/
  app/                Next.js: landing, dashboard, chat, API routes
  app/api/x402/       the paid endpoints (Tracks 1 & 2)
  lib/dex/            Mento, Uniswap (hot loop) · Squid, LiFi (funding)
  lib/strategy/       riskProfile (incl. the agent's pushback), scanner, executor
  lib/vault/          operator signer (the ONE server-held key — see SECURITY.md)
  lib/x402/           payment gate (thirdweb facilitator on Celo)
  lib/attribution.ts  ERC-8021 tags on every operator transaction
  scripts/worker.ts   the heartbeat loop
SECURITY.md           the custody model in full
```

## Status

- **Deployed to Celo Sepolia** — `VaultFactory` address configured
- **Hackathon registration complete** — attribution tag issued and wired
  into `NEXT_PUBLIC_ATTRIBUTION_APP_ID`
- **x402 configured** — API key and payout wallet set for both endpoints
- **Pending:** production MongoDB connection string (still a placeholder
  in local config), AskBots judge-bot registration, and the Aigora
  `fx-route` listing
- **Pending:** recorded demo — a live feed showing both executed and
  declined trades, one x402 payment from another wallet, and one user
  withdrawal
