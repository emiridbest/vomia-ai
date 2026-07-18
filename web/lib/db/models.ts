/**
 * Mongo schemas for Vomia.
 *
 * WHAT DOES NOT LIVE HERE, ON PURPOSE: any private key, seed phrase, or
 * signing credential for a user's own wallet. That wallet is created and
 * held by Web3Auth (MPC across their node network + this app + the user's
 * device) — this backend never sees, requests, or stores it, encrypted or
 * otherwise. See ../../SECURITY.md for the full reasoning.
 *
 * The ONE key this system does hold server-side is the *agent operator*
 * key — a low-privilege key that can only call AgentVault.executeSwap, and
 * only within the caps each user set on their own vault on-chain. That key
 * lives in your KMS/secrets manager (see lib/vault/operatorSigner.ts), not
 * in this database, and it is shared across all users (it's the agent's
 * key, not any individual user's).
 */
import mongoose, { Schema, model, models } from "mongoose";

// ---------------------------------------------------------------------
// User — links a Web3Auth identity to their on-chain vault. No secrets.
// ---------------------------------------------------------------------
export interface UserDoc {
  walletAddress: string; // the user's own address, derived client-side by Web3Auth — public info. Primary key.
  web3AuthSub?: string; // Web3Auth's stable per-user subject id, when available (its own fetch can be flaky/slow — never block on it)
  vaultAddress?: string; // this user's AgentVault clone, once created
  minipayDetected: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<UserDoc>(
  {
    walletAddress: { type: String, required: true, unique: true, index: true },
    web3AuthSub: { type: String, index: true, sparse: true },
    vaultAddress: { type: String },
    minipayDetected: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------
// RiskProfile — the user's plain-language rule, translated into numbers.
// Mirrors (and is validated against) the caps stored on the vault
// contract itself; this copy exists so the UI and the off-chain scanner
// have something fast to read without an RPC call on every loop tick.
// The on-chain values in AgentVault are always the source of truth.
// ---------------------------------------------------------------------
export interface RiskProfileDoc {
  userId: mongoose.Types.ObjectId;
  minProfitBps: number; // scanner won't submit a trade below this net-of-gas edge
  maxSlippageBps: number;
  maxTradesPerDay: number; // soft cap the scanner self-enforces, independent of the vault's token-unit caps
  enabledStrategies: ("rebalance" | "arbitrage" | "remittance" | "dca")[];
  allowedTokenPairs: { tokenIn: string; tokenOut: string }[]; // symbols, e.g. { tokenIn: "USDm", tokenOut: "KESm" }
  paused: boolean; // mirrors on-chain pause state for fast reads; on-chain is authoritative
  updatedAt: Date;
}

const RiskProfileSchema = new Schema<RiskProfileDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "VomiaUser", required: true, unique: true },
    minProfitBps: { type: Number, default: 15, min: 0 },
    maxSlippageBps: { type: Number, default: 100, min: 0, max: 2000 },
    maxTradesPerDay: { type: Number, default: 50, min: 0 },
    enabledStrategies: {
      type: [String],
      enum: ["rebalance", "arbitrage", "remittance", "dca"],
      default: ["rebalance"],
    },
    allowedTokenPairs: [
      {
        tokenIn: String,
        tokenOut: String,
      },
    ],
    paused: { type: Boolean, default: true }, // starts paused — the user opts in, not the other way around
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------
// TradeLog — an off-chain mirror of AgentAction events, for fast display
// on the dashboard/live-feed without re-querying the chain constantly.
// Every row should be reconstructable from on-chain events alone.
// ---------------------------------------------------------------------
export interface TradeLogDoc {
  userId: mongoose.Types.ObjectId;
  vaultAddress: string;
  actionId: string; // hex, matches the on-chain idempotency key
  strategy: "rebalance" | "arbitrage" | "remittance" | "dca" | "price-check";
  tokenIn: string;
  tokenOut: string;
  amountIn: string; // stored as string — token amounts can exceed JS safe-integer range
  amountOut?: string;
  status: "quoted" | "submitted" | "settled" | "reverted" | "skipped-below-margin";
  txHash?: string;
  quotedProfitBps?: number;
  gasUsdEstimate?: number;
  x402PaymentRef?: string; // set when this row was itself a paid x402 call (e.g. a price-check)
  createdAt: Date;
}

const TradeLogSchema = new Schema<TradeLogDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "VomiaUser", required: true, index: true },
    vaultAddress: { type: String, required: true, index: true },
    actionId: { type: String, required: true, unique: true },
    strategy: { type: String, enum: ["rebalance", "arbitrage", "remittance", "dca", "price-check"], required: true },
    tokenIn: String,
    tokenOut: String,
    amountIn: String,
    amountOut: String,
    status: {
      type: String,
      enum: ["quoted", "submitted", "settled", "reverted", "skipped-below-margin"],
      required: true,
    },
    txHash: String,
    quotedProfitBps: Number,
    gasUsdEstimate: Number,
    x402PaymentRef: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// ---------------------------------------------------------------------
// FeeAccrual — metered service fees, one document per user per UTC day.
// The agent can never pull these from the vault (owner-only withdrawals,
// by design) — this ledger is what the user owes for the agent's work
// (route lookups, oracle reads, executed trades), settled out-of-band via
// x402 after the free-trial window. During the trial the dashboard shows
// the accrued amount as waived.
// ---------------------------------------------------------------------
export interface FeeAccrualDoc {
  userId: mongoose.Types.ObjectId;
  day: string; // UTC date, "YYYY-MM-DD"
  checks: number; // scan/oracle/route lookups performed
  trades: number; // executed (settled) trades
  usdcOwed: number; // accrued fee total for the day, in USDC
}

const FeeAccrualSchema = new Schema<FeeAccrualDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "VomiaUser", required: true, index: true },
    day: { type: String, required: true },
    checks: { type: Number, default: 0 },
    trades: { type: Number, default: 0 },
    usdcOwed: { type: Number, default: 0 },
  },
  { timestamps: true }
);
FeeAccrualSchema.index({ userId: 1, day: 1 }, { unique: true });

// Model + collection names are prefixed "Vomia"/"vomia_" on purpose: MONGODB_URI
// points at a shared cluster with no database name in the connection string
// (so it lands in that cluster's default database), and generic names like
// "User" risk colliding with another project's collection there.
export const User = models.VomiaUser || model<UserDoc>("VomiaUser", UserSchema, "vomia_users");
export const RiskProfile =
  models.VomiaRiskProfile || model<RiskProfileDoc>("VomiaRiskProfile", RiskProfileSchema, "vomia_risk_profiles");
export const TradeLog =
  models.VomiaTradeLog || model<TradeLogDoc>("VomiaTradeLog", TradeLogSchema, "vomia_trade_logs");
export const FeeAccrual =
  models.VomiaFeeAccrual || model<FeeAccrualDoc>("VomiaFeeAccrual", FeeAccrualSchema, "vomia_fee_accruals");

/** Fee schedule (USDC). Per-CHECK pricing on purpose: the agent's costs
 * (RPC, oracle reads, route quotes) accrue whether or not a trade fires. */
export const FEE_PER_CHECK_USDC = 0.001;
export const FEE_PER_TRADE_USDC = 0.01;

/** Meter a fee event. Fire-and-forget safe: billing must never break trading. */
export async function accrueFee(userId: string, kind: "check" | "trade", count = 1): Promise<void> {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const usdc = (kind === "check" ? FEE_PER_CHECK_USDC : FEE_PER_TRADE_USDC) * count;
    await FeeAccrual.updateOne(
      { userId, day },
      { $inc: { [kind === "check" ? "checks" : "trades"]: count, usdcOwed: usdc } },
      { upsert: true }
    );
  } catch {
    // never let fee metering interfere with trading
  }
}
