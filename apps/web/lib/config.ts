import { http, createConfig } from "wagmi";
import { zeroAddress } from "viem";
import { injected, safe, walletConnect } from "wagmi/connectors";
import { robinhood, type HoodAddresses } from "@hood/sdk";
import { safeAware, safeTracking } from "./safe-core";

/// A phone has no extension to inject a wallet, so without this the site is desktop only. It costs
/// a project id from WalletConnect and nothing else; with none set the connector is simply not
/// offered, rather than offered and broken, because a wallet picker that fails on tap is worse than
/// one that is not there.
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim();

/// Which frames may act as the wallet. The Safe SDK tests these against the full origin of each
/// message, scheme included, so an exact match is what belongs here and a hostname alone would
/// never match.
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const safeAppOrigins = [
  /^https:\/\/app\.safe\.global$/,
  ...(process.env.NEXT_PUBLIC_SAFE_APP_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => new RegExp(`^${escape(o)}$`)),
];

/// Every connector goes through `safeTracking` and the transport through `safeAware` (lib/safe.ts):
/// a Safe on the other end proposes instead of sending, and those two are what make the app wait
/// for the Safe's signers rather than for a hash that will never be mined.
///
/// `safe()` is the connector Safe{Wallet} uses when it opens hood.fam as a Safe App. It only answers
/// inside Safe{Wallet}'s frame, from app.safe.global and nowhere else; the page's CSP lets that one
/// origin frame it (next.config.mjs). An organisation running its own Safe{Wallet} adds its origin
/// with NEXT_PUBLIC_SAFE_APP_ORIGINS, and then has to allow it in the CSP too; the Safe App harness
/// in scripts/e2e uses the same door to stand in for Safe{Wallet} on localhost.
export const wagmiConfig = createConfig({
  chains: [robinhood],
  connectors: [
    safeTracking(safe({ allowedDomains: safeAppOrigins, unstable_getInfoTimeout: 1_000 })),
    safeTracking(injected()),
    ...(walletConnectProjectId
      ? [safeTracking(walletConnect({ projectId: walletConnectProjectId, showQrModal: true }))]
      : []),
  ],
  // The chain's public RPC currently emits invalid duplicate CORS headers. The same-origin route
  // forwards a deliberately small read-only JSON-RPC surface, while a deployment may still point
  // NEXT_PUBLIC_RPC at its own browser-safe node.
  transports: { [robinhood.id]: safeAware(http(process.env.NEXT_PUBLIC_RPC || "/api/rpc")) },
  ssr: true,
});

export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8080";

/// An address this deployment never set. Docker passes every build arg through whether it was
/// filled in or not, so an unset address arrives as the empty string rather than as undefined, and
/// `??` would hand that empty string to wagmi: every read fails and every write goes nowhere,
/// without anything saying the deployment is unwired. Empty is absent.
function configured(value?: string): `0x${string}` | undefined {
  const address = value?.trim();
  return address ? (address as `0x${string}`) : undefined;
}

export const addresses: HoodAddresses = {
  factory: configured(process.env.NEXT_PUBLIC_FACTORY) ?? zeroAddress,
  feeRouter: configured(process.env.NEXT_PUBLIC_FEE_ROUTER) ?? zeroAddress,
  staking: configured(process.env.NEXT_PUBLIC_STAKING) ?? zeroAddress,
  graduator: configured(process.env.NEXT_PUBLIC_GRADUATOR) ?? zeroAddress,
  curveRouter: configured(process.env.NEXT_PUBLIC_CURVE_ROUTER),
  bridgeFactory: configured(process.env.NEXT_PUBLIC_BRIDGE_FACTORY),
};

/// The direct machine: no curve, the supply is the liquidity from block one.
export const directAddresses = {
  portal: configured(process.env.NEXT_PUBLIC_PORTAL),
  deployer: configured(process.env.NEXT_PUBLIC_DIRECT_DEPLOYER),
  buybackModule: configured(process.env.NEXT_PUBLIC_BUYBACK_MODULE),
};

export const EXPLORER = "https://robinhoodchain.blockscout.com";
