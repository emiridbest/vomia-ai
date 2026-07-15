/**
 * Attribution Tags (ERC-8021), via the official `@celo/attribution-tags`
 * package. An earlier version of this file hand-rolled the suffix format
 * and was missing a length-prefix byte the real spec requires — confirmed
 * broken by running the official package's own verifyTx() against a real
 * transaction we'd already sent (it returned null, i.e. unrecognized).
 *
 * Loaded via dynamic import() rather than a static import: this project's
 * .ts files resolve as CommonJS (no "type": "module" in package.json), and
 * @celo/attribution-tags only declares an ESM "import" condition in its
 * exports map — a static import fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
 * Dynamic import() always uses ESM resolution regardless of the caller's
 * module type, so it works from both the Next.js app and the plain-node
 * worker. Cached after the first call.
 */
import { concat, type Hex } from "viem";

const APP_IDENTIFIER = process.env.NEXT_PUBLIC_ATTRIBUTION_APP_ID || "vomia";

let toDataSuffixFn: ((code: string) => Hex) | null = null;

async function loadToDataSuffix() {
  if (!toDataSuffixFn) {
    const mod = await import("@celo/attribution-tags");
    toDataSuffixFn = mod.toDataSuffix as (code: string) => Hex;
  }
  return toDataSuffixFn;
}

export async function attachAttributionTag(callData: Hex, appId: string = APP_IDENTIFIER): Promise<Hex> {
  const toDataSuffix = await loadToDataSuffix();
  return concat([callData, toDataSuffix(appId)]);
}
