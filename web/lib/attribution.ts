/**
 * Attribution Tags (ERC-8021).
 *
 * The standard works by appending a data suffix to transaction calldata
 * that every EVM contract already safely ignores — Solidity discards extra
 * calldata beyond what a function's arguments consume, so this suffix rides
 * along on a normal `executeSwap` / `swapIn` / `exactInputSingle` call
 * without changing what it does. An off-chain indexer (or anyone parsing
 * the chain) can then read the suffix back off and attribute the
 * transaction to this project, which is what both the Revenue and
 * x402-payments hackathon tracks almost certainly measure from.
 *
 * The newsletter says this is "one line of code" via the official
 * `@celo/attribution-tags` npm package — install it and prefer that package
 * once you've confirmed its exact export names, since it will track any
 * spec revisions automatically. The function below is a from-spec fallback
 * (built directly from ERC-8021's documented suffix format: a constant
 * 16-byte marker, a schema id, and a human-readable ASCII app identifier)
 * so this project works correctly even before you've wired up the package.
 * Swap the body for the real package's call once you have it — the call
 * site (executor.ts) doesn't need to change either way.
 */
import { concat, stringToHex, toHex, type Hex } from "viem";

const ERC8021_MARKER: Hex = "0x80218021802180218021802180218021"; // 16 bytes, "8021" repeated — the fixed suffix marker
const SCHEMA_ID_ASCII = 0x00; // schema 0: plain ASCII app identifier, per the ERC-8021 base schema

const APP_IDENTIFIER = process.env.NEXT_PUBLIC_ATTRIBUTION_APP_ID || "vomia";

export function attachAttributionTag(callData: Hex, appId: string = APP_IDENTIFIER): Hex {
  const appIdHex = stringToHex(appId); // human-readable ASCII, e.g. "vomia"
  const schemaByte = toHex(SCHEMA_ID_ASCII, { size: 1 });
  return concat([callData, appIdHex, schemaByte, ERC8021_MARKER]);
}

/**
 * Strips a previously-attached tag back off — useful for tests/debugging,
 * not needed in the hot path.
 */
export function stripAttributionTag(taggedCallData: Hex): Hex {
  if (!taggedCallData.endsWith(ERC8021_MARKER.slice(2))) return taggedCallData;
  const withoutMarker = taggedCallData.slice(0, -ERC8021_MARKER.slice(2).length);
  const withoutSchema = withoutMarker.slice(0, -2); // one schema byte = 2 hex chars
  // app identifier length varies — this helper is best-effort for
  // debugging/tests, not relied on anywhere in the execution path.
  return withoutSchema as Hex;
}
