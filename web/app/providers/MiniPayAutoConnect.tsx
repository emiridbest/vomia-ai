"use client";

import { useMiniPayAutoConnect } from "../hooks/useMiniPay";

/**
 * Runs the MiniPay auto-connect effect. Must live INSIDE the wagmi provider
 * (it uses wagmi hooks). Renders nothing.
 */
export default function MiniPayAutoConnect() {
  useMiniPayAutoConnect();
  return null;
}
