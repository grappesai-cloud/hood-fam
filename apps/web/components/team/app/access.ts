import { isAddress } from "viem";

/// Who may open the team console. The console is ours: it shows itself to the funder wallets named
/// on the build and to nobody else. `NEXT_PUBLIC_TEAM_WALLETS` is a comma-separated list of
/// addresses; empty closes the console to everyone, and "*" opens it to every visitor, which is
/// for local work only. This gates the pages, not the chain: block zero itself has no owner and
/// takes any launcher.
const raw = (process.env.NEXT_PUBLIC_TEAM_WALLETS ?? "").trim();

export const CONSOLE_OPEN_TO_ALL = raw === "*";

export const TEAM_WALLETS: readonly string[] = raw
  .split(/[\s,;]+/)
  .filter((a) => isAddress(a))
  .map((a) => a.toLowerCase());

export function isTeamWallet(address: string | undefined): boolean {
  if (CONSOLE_OPEN_TO_ALL) return true;
  return Boolean(address) && TEAM_WALLETS.includes(address!.toLowerCase());
}
