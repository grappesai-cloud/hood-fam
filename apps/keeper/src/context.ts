import type { Account, Address, PublicClient } from "viem";
import type { DirectClient, HoodClient } from "@hood/sdk";
import type { Api } from "./api.js";
import type { WriteQueue } from "./queue.js";

/// Everything a job needs, built once at boot and handed to every loop.
export interface Ctx {
  publicClient: PublicClient;
  account: Account;
  queue: WriteQueue;
  api: Api;
  hood: HoodClient;
  direct?: DirectClient;
  /// The Bag v3 contracts. Each one is optional: a job whose address is missing is off.
  payday?: Address;
  burnClock?: Address;
  boosts?: Address;
  bag?: Address;
  /// Curve fee buybacks need the fee router's appointed keeper. Read at boot, refreshed by the tick.
  buybacksAppointed: boolean;
  knobs: {
    minFlushWei: bigint;
    paydayDustWei: bigint;
    pushFloorWei: bigint;
    pushEveryMs: number;
    burnSlippageBps: number;
    tickEveryMs: number;
  };
  /// Every asset a pot or the Bag can hold: the SDK's pair list plus whatever the launches use.
  assets(): Promise<Address[]>;
  symbol(asset: string): string;
}

export type Counts = Record<string, number | string | undefined>;
export type Job = () => Promise<Counts>;
