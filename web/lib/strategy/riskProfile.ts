/**
 * The risk profile is the knob the user turns; the scanner and executor
 * both read it before doing anything. This is also where the agent "asks
 * and demands" on risk/profit margins, as requested — see
 * `reviewProposedProfile` below. The agent can refuse to run with a
 * self-destructive setting, the same way a competent human operator would
 * push back rather than silently comply.
 */

export type Strategy = "rebalance" | "arbitrage" | "remittance" | "dca";

export interface RiskProfile {
  minProfitBps: number; // net of estimated gas + the venue's own fee — floor for the scanner to even consider a trade
  maxSlippageBps: number; // must be <= the vault contract's own maxSlippageBps; the tighter of the two wins
  maxTradesPerDay: number; // scanner-side soft cap, independent of the vault's per-token unit caps
  enabledStrategies: Strategy[];
}

export const DEFAULT_RISK_PROFILE: RiskProfile = {
  minProfitBps: 15, // 0.15% net edge required before the scanner will even quote a trade
  maxSlippageBps: 100, // 1%
  maxTradesPerDay: 50,
  enabledStrategies: ["rebalance"],
};

export interface ProfileReview {
  accepted: boolean;
  warnings: string[];
  adjusted?: Partial<RiskProfile>;
}

/**
 * The agent's "push back" step. Called whenever a user proposes a new risk
 * profile (from the dashboard or from a plain-language chat instruction).
 * This does not silently accept numbers that would make the bot lose money
 * or trade recklessly — it explains what's wrong and offers a safer
 * alternative, mirroring how the vault contract itself hard-caps
 * maxSlippageBps at 20%.
 */
export function reviewProposedProfile(proposed: Partial<RiskProfile>, estimatedGasBps: number): ProfileReview {
  const warnings: string[] = [];
  const adjusted: Partial<RiskProfile> = { ...proposed };

  if (proposed.minProfitBps !== undefined && proposed.minProfitBps < estimatedGasBps) {
    warnings.push(
      `A minimum profit of ${proposed.minProfitBps}bps is below the current estimated gas+fee cost of ` +
        `${estimatedGasBps}bps per trade. Every trade would execute at a guaranteed loss. Raising the floor to ` +
        `${estimatedGasBps + 5}bps (gas cost plus a 5bps margin) instead.`
    );
    adjusted.minProfitBps = estimatedGasBps + 5;
  }

  if (proposed.maxSlippageBps !== undefined && proposed.maxSlippageBps > 2000) {
    warnings.push(
      `${proposed.maxSlippageBps}bps (${(proposed.maxSlippageBps / 100).toFixed(1)}%) max slippage is above the ` +
        `vault contract's own hard ceiling of 2000bps (20%) and will simply revert on-chain. Capping at 2000bps.`
    );
    adjusted.maxSlippageBps = 2000;
  } else if (proposed.maxSlippageBps !== undefined && proposed.maxSlippageBps > 300) {
    warnings.push(
      `${proposed.maxSlippageBps}bps max slippage is unusually high for stablecoin-to-stablecoin pairs — ` +
        `that's a lot of room for a bad fill. Consider 100-300bps unless you have a specific reason.`
    );
  }

  if (proposed.maxTradesPerDay !== undefined && proposed.maxTradesPerDay > 2000) {
    warnings.push(
      `${proposed.maxTradesPerDay} trades/day is a lot of gas spend on checks alone even at Celo's sub-cent fees. ` +
        `Confirm this is intentional — most rebalancing strategies don't need more than a few dozen real executions ` +
        `a day; if the goal is x402 call *volume* rather than trade *count*, price-checks that decline to trade are ` +
        `cheaper than always executing.`
    );
  }

  return { accepted: warnings.length === 0, warnings, adjusted: warnings.length ? adjusted : undefined };
}

export function netEdgeBps(quotedOutBps: number, venueFeeBps: number, gasBps: number): number {
  return quotedOutBps - venueFeeBps - gasBps;
}
