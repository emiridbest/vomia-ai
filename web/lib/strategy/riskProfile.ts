/**
 * The risk profile is the knob the user turns; the scanner and executor read
 * it before acting. reviewProposedProfile below is where the agent pushes
 * back on self-destructive settings rather than silently complying.
 */

export type Strategy = "rebalance" | "arbitrage" | "remittance" | "dca";

export interface RiskProfile {
  minProfitBps: number; // net of estimated gas + the venue's own fee — floor for the scanner to even consider a trade
  maxSlippageBps: number; // must be <= the vault contract's own maxSlippageBps; the tighter of the two wins
  maxTradesPerDay: number; // scanner-side soft cap, independent of the vault's per-token unit caps
  enabledStrategies: Strategy[];
}

export const DEFAULT_RISK_PROFILE: RiskProfile = {
  minProfitBps: 5, // 0.05% net edge floor (below-gas floors were pure spread bleed at 1-minute holds)
  maxSlippageBps: 100, // 1%
  maxTradesPerDay: 50,
  enabledStrategies: ["arbitrage"],
};

export interface ProfileReview {
  accepted: boolean;
  warnings: string[];
  adjusted?: Partial<RiskProfile>;
}

/**
 * The agent's push-back step, called whenever a user proposes a new risk
 * profile. Rather than silently accepting numbers that lose money or trade
 * recklessly, it warns and offers a safer alternative (and hard-caps
 * maxSlippageBps at the vault's own 20% ceiling).
 */
export function reviewProposedProfile(proposed: Partial<RiskProfile>, estimatedGasBps: number): ProfileReview {
  const warnings: string[] = [];
  const adjusted: Partial<RiskProfile> = { ...proposed };

  if (proposed.minProfitBps !== undefined && proposed.minProfitBps < estimatedGasBps) {
    // Warn but don't override: a below-gas floor is a supported, deliberate
    // choice (trading through negative measured edge for volume/drift
    // exposure). Informed consent, not a veto — it saves after acknowledgement.
    warnings.push(
      `A minimum profit of ${proposed.minProfitBps}bps is below the estimated gas+fee cost of ` +
        `${estimatedGasBps}bps per trade — entries will knowingly execute at negative measured edge, relying on ` +
        `price drift during the hold and exit timing for profitability. Confirm to proceed with this setting.`
    );
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
