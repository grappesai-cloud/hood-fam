import { createPublicClient, createWalletClient, http, type PrivateKeyAccount, type Address } from "viem";
import { createHoodClient, createDirectClient, robinhood, addressesFromEnv, type HoodAddresses, type DirectAddresses } from "@hood/sdk";
import { unlockWallet, listWallets } from "@hood/sdk/keystore";

/// Everything the tools share: one RPC, one launchpad, and whatever wallet the session unlocked.
/// A key never crosses the tool boundary. Tools take a label, the account lives here.
export class Context {
  readonly rpcUrl: string;
  readonly addresses: HoodAddresses;
  readonly apiUrl?: string;
  /// AGENT_MODE=1 lets an autonomous agent send transactions without a human confirming each one.
  readonly agentMode: boolean;
  private account?: PrivateKeyAccount;
  private accountLabel?: string;
  treasury?: Address;

  constructor() {
    this.rpcUrl = process.env.HOOD_RPC ?? robinhood.rpcUrls.default.http[0]!;
    this.addresses = addressesFromEnv();
    this.apiUrl = process.env.HOOD_API;
    this.agentMode = process.env.AGENT_MODE === "1";
    this.treasury = process.env.HOOD_TREASURY as Address | undefined;

    if (process.env.HOOD_WALLET_LABEL && process.env.HOOD_WALLET_PASSWORD) {
      this.unlock(process.env.HOOD_WALLET_LABEL, process.env.HOOD_WALLET_PASSWORD);
    }
  }

  get publicClient() {
    return createPublicClient({ chain: robinhood, transport: http(this.rpcUrl) });
  }

  get walletClient() {
    if (!this.account) return undefined;
    return createWalletClient({ account: this.account, chain: robinhood, transport: http(this.rpcUrl) });
  }

  /// The direct machine, when this deployment has one.
  get direct() {
    const portal = process.env.HOOD_PORTAL as `0x${string}` | undefined;
    const deployer = process.env.HOOD_DIRECT_DEPLOYER as `0x${string}` | undefined;
    const buybackModule = process.env.HOOD_BUYBACK_MODULE as `0x${string}` | undefined;
    if (!portal || !deployer || !buybackModule) {
      throw new Error(
        "direct launches need HOOD_PORTAL, HOOD_DIRECT_DEPLOYER and HOOD_BUYBACK_MODULE in the environment",
      );
    }
    const addresses: DirectAddresses = { portal, deployer, buybackModule };
    return createDirectClient({
      publicClient: this.publicClient as never,
      walletClient: this.walletClient as never,
      addresses,
    });
  }

  get client() {
    return createHoodClient({
      publicClient: this.publicClient as never,
      walletClient: this.walletClient as never,
      addresses: this.addresses,
    });
  }

  unlock(label: string, password: string) {
    this.account = unlockWallet(label, password);
    this.accountLabel = label;
    return { label, address: this.account.address };
  }

  lock() {
    this.account = undefined;
    this.accountLabel = undefined;
  }

  get signer() {
    return this.account ? { label: this.accountLabel!, address: this.account.address } : undefined;
  }

  requireSigner() {
    if (!this.account) {
      throw new Error(
        `no wallet unlocked. Use hood_wallet_unlock with one of: ${listWallets().map((w) => w.label).join(", ") || "none yet, create one with hood_wallet_new"}`,
      );
    }
    return this.account;
  }

  /// Outside AGENT_MODE, a write needs an explicit confirm from the caller.
  requireConfirm(confirm: boolean | undefined, what: string) {
    if (this.agentMode || confirm) return;
    throw new Error(
      `${what} sends a real transaction. Call again with confirm: true, or run the server with AGENT_MODE=1 to let an agent act on its own.`,
    );
  }
}
