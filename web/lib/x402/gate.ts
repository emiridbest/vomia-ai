/**
 * x402 payment gate — targets Celo Core Co's HOSTED FACILITATOR
 * (https://api.x402.celo.org), the one announced in the hackathon
 * newsletter. This replaced an earlier thirdweb-SDK-based version: Celo's
 * docs document the thirdweb path too, but for the hackathon it matters
 * that payments settle through *Celo's own* facilitator, since that's the
 * infrastructure Track 2's "most x402 payments" metering is guaranteed to
 * see — and the REST API needs zero SDK dependencies.
 *
 * Flow (standard x402):
 *   1. Request arrives with no payment → we return HTTP 402 with an
 *      `accepts` array describing price, asset (USDC on Celo — the
 *      facilitator settles EIP-3009 USDC transfers), and payTo.
 *   2. The client (an agent) signs an EIP-3009 transferWithAuthorization
 *      and retries with the payload in the X-PAYMENT header (gasless for
 *      the payer — the facilitator broadcasts it).
 *   3. We forward that payload to the facilitator's /settle endpoint with
 *      our API key. `{"settled": true}` → run the real handler. Funds move
 *      buyer → X402_PAYOUT_WALLET_ADDRESS directly; the facilitator never
 *      holds them.
 *
 * ECONOMICS NOTE: the hosted facilitator charges 1 prepaid credit
 * (~$0.001) per settlement. Price every endpoint ABOVE that or you're
 * paying to be called — this is why /api/x402/check now defaults to
 * $0.005, not $0.001.
 *
 * Setup: connect a wallet at api.x402.celo.org (message signature, no
 * gas) → get an API key + 500 free credits → set CELO_X402_API_KEY.
 * Testnet ships with free credits on the same key; flip
 * NEXT_PUBLIC_NETWORK when ready.
 *
 * Confirm the exact /settle request schema against the facilitator's own
 * docs once you have an account — the body below matches their published
 * example (`{"payment": <x402-payload>, "network": "celo"}`); if their
 * full docs expose the standard `/verify` + `{paymentPayload,
 * paymentRequirements}` shape as well, prefer verify-then-settle so you
 * only spend a credit on payloads that pass verification.
 */
import { NextRequest, NextResponse } from "next/server";

const FACILITATOR_URL = process.env.CELO_X402_FACILITATOR_URL || "https://api.x402.celo.org";

// USDC on Celo — verified against docs.celo.org's canonical token list.
// The hosted facilitator settles USDC via EIP-3009 (USDm/cUSD doesn't
// implement transferWithAuthorization, so USDC is the right asset here).
const USDC_CELO = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
const USDC_CELO_SEPOLIA = "0x01C5C0122039549AD1493B8220cABEdD739BC44E";
const USDC_DECIMALS = 6;

export interface X402GateOptions {
  /** Human-readable price, e.g. "$0.01". Must exceed the facilitator's ~$0.001/settlement credit. */
  price: string;
  description?: string;
}

function network(): "celo" | "celo-sepolia" {
  return process.env.NEXT_PUBLIC_NETWORK === "testnet" ? "celo-sepolia" : "celo";
}

function priceToAtomicUsdc(price: string): string {
  const dollars = Number(price.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(dollars) || dollars <= 0) throw new Error(`Bad x402 price: ${price}`);
  return String(Math.round(dollars * 10 ** USDC_DECIMALS));
}

function paymentRequirements(req: NextRequest, options: X402GateOptions) {
  const isTestnet = network() === "celo-sepolia";
  return {
    scheme: "exact",
    network: network(),
    maxAmountRequired: priceToAtomicUsdc(options.price),
    asset: isTestnet ? USDC_CELO_SEPOLIA : USDC_CELO,
    payTo: process.env.X402_PAYOUT_WALLET_ADDRESS,
    resource: req.url,
    description: options.description ?? "Vomia paid endpoint",
    mimeType: "application/json",
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" }, // EIP-712 domain for USDC's EIP-3009 authorization
  };
}

export function withX402(options: X402GateOptions, handler: (req: NextRequest) => Promise<NextResponse>) {
  return async function gated(req: NextRequest): Promise<NextResponse> {
    const apiKey = process.env.CELO_X402_API_KEY;
    const payTo = process.env.X402_PAYOUT_WALLET_ADDRESS;
    if (!apiKey || !payTo) {
      return NextResponse.json(
        { error: "x402 not configured — set CELO_X402_API_KEY (from api.x402.celo.org) and X402_PAYOUT_WALLET_ADDRESS." },
        { status: 500 }
      );
    }

    // x402 clients send the signed payment payload in X-PAYMENT (some older
    // clients use PAYMENT-SIGNATURE — accept both).
    const paymentPayload = req.headers.get("x-payment") || req.headers.get("payment-signature");

    if (!paymentPayload) {
      // Step 1: no payment attached → 402 with requirements.
      return NextResponse.json(
        { x402Version: 1, error: "Payment required", accepts: [paymentRequirements(req, options)] },
        { status: 402 }
      );
    }

    // Step 2: forward to Celo's facilitator to verify + settle on-chain.
    let settled = false;
    let facilitatorBody: unknown = null;
    try {
      const res = await fetch(`${FACILITATOR_URL}/settle`, {
        method: "POST",
        headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ payment: paymentPayload, network: network() }),
      });
      facilitatorBody = await res.json().catch(() => null);
      settled = res.ok && (facilitatorBody as any)?.settled === true;
    } catch (err) {
      return NextResponse.json(
        { error: "Payment facilitator unreachable — try again.", detail: err instanceof Error ? err.message : String(err) },
        { status: 502 }
      );
    }

    if (!settled) {
      // Invalid/expired/underpriced payload → re-issue the 402 so a
      // well-behaved agent client can re-sign and retry.
      return NextResponse.json(
        {
          x402Version: 1,
          error: "Payment could not be settled",
          facilitatorResponse: facilitatorBody,
          accepts: [paymentRequirements(req, options)],
        },
        { status: 402 }
      );
    }

    return handler(req);
  };
}
