# Security model

This document exists because the original spec for this project asked for
something that cannot work as described, and the replacement needs to be
understood — not just trusted — by whoever operates this.

## Why the original spec was changed

The request was: *"the system generates a new wallet for them whose private
key is stored in the database securely... MongoDB (hashed)... so when this
user makes a call, the database produces the private key to sign."*

Two separate problems:

1. **"Hashed" keys can't sign.** Hashing is one-way. A hashed private key
   can never be turned back into the key, so it can never "produce the
   private key to sign a transaction." What was meant was almost certainly
   *encryption* (reversible). This isn't pedantry — the difference is the
   difference between a system that works and one that doesn't.

2. **Even encrypted, a database of every user's full wallet key is a
   single point of catastrophic failure.** One leaked encryption env var,
   one NoSQL injection, one malicious insider, one misconfigured backup —
   and every user is drained simultaneously, irreversibly (stablecoin
   transfers have no chargebacks). This is the exact architecture behind
   most of the large custodial-service losses in this industry's history.

## What this project does instead

Three keys, three very different privilege levels:

| Key | Who holds it | What it can do | Blast radius if compromised |
|---|---|---|---|
| **User's wallet key** | Web3Auth MPC (user's device + Web3Auth's node network). Never touches this codebase or database, even encrypted. | Everything: deposit, withdraw, set caps, pause, change operator. | That one user — and only via compromising *their* login/device, not our infrastructure. |
| **Agent operator key** | This service (env var now; KMS before real funds — see below). | ONLY `AgentVault.executeSwap`, within each vault's on-chain allow-lists and caps. Can trip a vault's circuit breaker but cannot lift it. Cannot withdraw from any vault, ever. | Bounded per-user by the caps that user set: worst case, bad trades up to their daily cap between allow-listed tokens via allow-listed routers, until owners pause. Funds cannot be sent to an attacker's address. |
| **Deployer key** | Whoever deploys contracts, once. | Deploy `AgentVault` implementation + `VaultFactory`; update the factory's default operator. | New vaults could be pointed at a bad default operator (existing vaults unaffected; users can also pass their own operator). |

MongoDB stores **zero key material** of any kind: users (login sub +
public addresses), risk profiles, trade logs. All of it is public-ish
metadata that is either derivable from the chain or harmless.

## What is enforced on-chain vs. off-chain

**On-chain (in `AgentVault.sol` — holds even if every line of TypeScript
in this repo is buggy or malicious):**
- Only the owner can withdraw; emergency withdrawal works even while paused
- Operator can only call `executeSwap`
- Token allow-list, target (router) allow-list
- Per-trade cap and rolling 24h cap, per token
- `minAmountOut` slippage enforcement per trade
- Action idempotency (a given actionId executes at most once)
- Operator may pause but never un-pause
- Owner's slippage setting hard-capped at 20%

**Off-chain (in the worker/scanner — quality, not safety):**
- Which trades are worth doing (profit margin vs. gas)
- The `minAmountOut` *value* submitted (derived from a live quote; the
  contract enforces it's met, but a hostile operator could submit a
  needlessly low one — this is why the caps above bound the damage)
- Daily trade-count budget, venue selection

This split is the point: the off-chain layer picks *good* trades; the
on-chain layer refuses *dangerous* ones, independently.

## Known gaps — read before mainnet with real user funds

1. **The contracts are hackathon-fresh.** 11 unit tests pass and the
   design follows well-worn patterns (OZ Clones, checks-effects-
   interactions, pull-only approvals reset after use), but no third party
   has audited them. Testnet first; small caps at launch; audit before
   scale. Do not skip this.
2. **Operator key is an env var.** Fine for a demo. Before real funds,
   move signing into KMS (AWS/GCP), or a wallet-as-a-service with policy
   controls (Turnkey, Privy server wallets, Fireblocks). The contract
   design makes this a drop-in hardening step, not a redesign.
3. **The scanner's "edge" math trusts its own quotes.** Before enabling
   the `arbitrage` strategy (off by default), wire a reference price feed
   (e.g. Mento's SortedOracles) so "profitable" is measured against an
   independent price, not the venue's own quote.
4. **`prepareWithdrawal` returns calldata the user signs blind-ish.** The
   chat UI shows a human-readable summary; keep that summary honest and
   consider EIP-712-style structured display before scale.
5. **Demo-identity seam.** `dashboard/page.tsx` currently sends a
   placeholder `web3AuthSub` until the Web3Auth provider is mounted around
   it; the API routes should verify the Web3Auth JWT (idToken) server-side
   before trusting any `web3AuthSub` — add that check in
   `app/api/risk-profile/route.ts` and `app/api/vault/route.ts` when you
   wire login. This is the one place where the current code trusts the
   client and must not in production.

## Things this system will refuse to do by design

- Accept, store, display, or transmit a user's private key or seed phrase
  (the chat agent is explicitly instructed to refuse and explain)
- Execute a withdrawal from the server side
- Un-pause a vault from the operator key
- Trade outside a user's allow-lists or caps (reverts on-chain)
- Manufacture trades to hit a volume target when the margin isn't there
