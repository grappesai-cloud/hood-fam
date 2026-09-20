#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { parseEther, parseUnits, formatEther, zeroAddress, type Address, type Hash } from "viem";

import { BPS, FEE_LEG_LABEL, LOCK_TIERS, compact, crossChainBuyLink, quoteCrossChainBuy, canQuoteCrossChain, routes, minOutFromQuote } from "@hood/sdk";
import { generateImage, uploadImage, ImageUploadError } from "@hood/sdk/image";
import { listWallets, newWallet, importWallet, removeWallet } from "@hood/sdk/keystore";

import { Context } from "./context.js";
import { WebSigner } from "./signer.js";

const ctx = new Context();
const signer = new WebSigner();

const json = (data: unknown) =>
  JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: json(data) }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

const addr = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "expected an address");
const server = new McpServer({ name: "hood-fam", version: "0.1.0" });

/// A launch writes its artwork string into calldata and into its own event, so a data URI there is
/// paid for twice at tens of millions of gas. A tiny one is somebody's placeholder and harmless;
/// past this the launch is refused rather than sent, because the bill arrives before the regret.
const MAX_INLINE_IMAGE = 8 * 1024;
const requireImageUrl = (image: string) => {
  if (image.startsWith("data:") && image.length > MAX_INLINE_IMAGE) {
    throw new Error(
      "that artwork is a data URI over 8 KB: stored on chain it costs a fortune in gas. " +
        "Store it first (hood_generate_image stores what it draws) and pass the URL.",
    );
  }
};

// ---------------------------------------------------------------- discovery

server.registerTool(
  "hood_supported_chains",
  {
    description: "The chain hood.fam launches on, and every route a launched token can travel over.",
    inputSchema: { token: addr.optional() },
  },
  async ({ token }) => {
    try {
      const open = await ctx.client.supportedRoutes(token as Address | undefined);
      return ok({
        home: { chainId: 4663, name: "Robinhood Chain", rpc: ctx.rpcUrl, eid: 30416 },
        routes: open,
        note: token
          ? "open=false means the protocol has not wired that route for this token yet"
          : "pass a token to see which routes are wired for it",
      });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_get_token",
  {
    description: "Everything about one launch: metadata, curve state, fee model, fees waiting to be pushed.",
    inputSchema: { token: addr },
  },
  async ({ token }) => {
    try {
      const c = ctx.client;
      const launch = await c.getLaunch(token as Address);
      if (!launch.exists) throw new Error("this launchpad did not print that token");
      if (launch.curve === zeroAddress) {
        // a direct launch has no curve; its numbers live on the hook and the splitter
        const d = ctx.direct;
        const row = await d.getLaunch(token as Address);
        const [taxes, buckets, metadata, status, meta] = await Promise.all([
          d.taxes(row.hook), d.buckets(row.splitter), d.metadata(token as Address),
          d.graduationStatus(token as Address), c.tokenMeta(token as Address),
        ]);
        return ok({ token, ...meta, machine: "direct", launch: row, taxes, buckets, metadata, status });
      }
      const [state, meta, fees] = await Promise.all([
        c.getCurveState(launch.curve),
        c.tokenMeta(token as Address),
        c.creatorFees(token as Address),
      ]);
      return ok({
        token, ...meta, machine: "curve", launch, state,
        marketCapPretty: compact(state.marketCap, launch.pairToken === zeroAddress ? 18 : 6),
        progressPct: Math.round(state.progress * 1000) / 10,
        feesWaiting: fees,
      });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_support",
  {
    description: "Ask the hood.fam support desk. It answers from the documentation and can read a token, a wallet or a transaction on chain (paste the hash). Needs HOOD_API. If it cannot help it can open a ticket for a person when you give it a contact.",
    inputSchema: {
      question: z.string().min(1).max(4000),
      history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) })).max(23).default([]),
      address: addr.optional(),
    },
  },
  async ({ question, history, address }) => {
    try {
      if (!ctx.apiUrl) throw new Error("hood_support needs HOOD_API (the indexer and support desk)");
      const res = await fetch(new URL("/support/chat", ctx.apiUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [...history, { role: "user", content: question }], address: address ?? null, page: "mcp" }),
      });
      if (res.status === 503) return ok({ answer: null, note: "the assistant is offline; open a ticket at POST /support/ticket with contact, subject and summary" });
      if (!res.ok) throw new Error(`support desk: ${res.status}`);
      const text = await res.text();
      let answer = "";
      let ticket: number | null = null;
      let error: string | null = null;
      for (const frame of text.split("\n\n")) {
        if (!frame.startsWith("data: ")) continue;
        const ev = JSON.parse(frame.slice(6)) as { type: string; delta?: string; id?: number; message?: string };
        if (ev.type === "text") answer += ev.delta;
        else if (ev.type === "ticket") ticket = ev.id ?? null;
        else if (ev.type === "error") error = ev.message ?? "error";
      }
      return ok({ answer, ticket, error });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_get_deployments",
  {
    description: "Recent launches. Reads the indexer when HOOD_API is set, otherwise scans the chain.",
    inputSchema: { limit: z.number().min(1).max(100).default(20), creator: addr.optional() },
  },
  async ({ limit, creator }) => {
    try {
      if (ctx.apiUrl) {
        const u = new URL("/tokens", ctx.apiUrl);
        u.searchParams.set("limit", String(limit));
        if (creator) u.searchParams.set("creator", creator);
        const res = await fetch(u);
        if (!res.ok) throw new Error(`indexer: ${res.status}`);
        return ok(await res.json());
      }
      const pc = ctx.publicClient;
      const head = await pc.getBlockNumber();
      const logs = await pc.getLogs({
        address: ctx.addresses.factory,
        event: {
          type: "event", name: "Launched",
          inputs: [
            { name: "token", type: "address", indexed: true },
            { name: "curve", type: "address", indexed: true },
            { name: "creator", type: "address", indexed: true },
            { name: "configId", type: "uint256" }, { name: "pairToken", type: "address" },
            {
              name: "feeSplit", type: "tuple",
              components: [
                { name: "stakersBps", type: "uint16" }, { name: "buybackBps", type: "uint16" },
                { name: "liquidityBps", type: "uint16" }, { name: "creatorBps", type: "uint16" },
              ],
            },
          ],
        },
        fromBlock: head > 500_000n ? head - 500_000n : 0n,
        toBlock: head,
      });
      const rows = logs.slice(-limit).reverse().map((l) => ({ ...l.args, block: l.blockNumber }));
      return ok({ source: "chain", count: rows.length, launches: rows });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_quote",
  {
    description: "What a buy or a sell would do right now, fees included.",
    inputSchema: {
      token: addr,
      side: z.enum(["buy", "sell"]).default("buy"),
      amount: z.string().describe("pair amount for a buy (e.g. '0.5'), token amount for a sell"),
    },
  },
  async ({ token, side, amount }) => {
    try {
      const c = ctx.client;
      const launch = await c.getLaunch(token as Address);
      if (!launch.exists) throw new Error("unknown token");
      const pairDecimals = launch.pairToken === zeroAddress ? 18 : 6;
      const value = BigInt(Math.round(Number(amount) * 10 ** (side === "buy" ? pairDecimals : 18)));
      if (launch.curve === zeroAddress) {
        // A direct launch trades on a real v4 pool: the fill comes from the chain's quoter running
        // the swap with the hook in the path, and the rate next to it says why it is what it is.
        const d = ctx.direct;
        const row = await d.getLaunch(token as Address);
        const [taxes, status, q] = await Promise.all([
          d.taxes(row.hook), d.graduationStatus(token as Address),
          d.quote({ token: token as Address, side, amountIn: value }),
        ]);
        const rateBps = side === "buy" ? taxes.buyBps : taxes.sellBps;
        return ok({
          side, amount, machine: "direct",
          amountOut: q.amountOut, minAmountOutAt1Pct: q.minAmountOut,
          taxBpsRightNow: rateBps, snipeBps: taxes.snipeBps, bonded: status.bonded,
          note: "the tax is taken in the quote asset on top of the pool's own fee; trade with hood_direct_buy or hood_direct_sell",
        });
      }
      const state = await c.getCurveState(launch.curve);
      const q = side === "buy" ? await c.quoteBuy(launch.curve, value) : await c.quoteSell(launch.curve, value);
      return ok({ side, amount, machine: "curve", phase: state.phase, quote: q, price: state.price, progressPct: state.progress * 100 });
    } catch (e) { return fail(e); }
  },
);

// ---------------------------------------------------------------- launching

server.registerTool(
  "hood_create_token",
  {
    description:
      "Plans a launch without sending anything: checks the ticker is free, pins the economics hash, " +
      "works out what the transaction will cost. Feed the result to hood_launch_token.",
    inputSchema: {
      name: z.string(), symbol: z.string(), description: z.string().default(""),
      image: z.string().default(""), website: z.string().default(""), twitter: z.string().default(""),
      telegram: z.string().default(""),
      // Four legs in basis points that must add up to 10,000. An agent that hands over three of
      // them and expects the fourth to be inferred gets a refusal, not a guess.
      stakersBps: z.number().int().min(0).max(BPS).default(BPS),
      buybackBps: z.number().int().min(0).max(BPS).default(0),
      liquidityBps: z.number().int().min(0).max(BPS).default(0),
      creatorBps: z.number().int().min(0).max(BPS).default(0),
      firstBuyLock: z.number().int().min(0).default(0).describe("seconds the creator's own first buy is locked in the staking vault: 0, or one of 7, 30, 90, 180 days"),
      configId: z.number().default(0),
      pairToken: addr.default(zeroAddress),
      firstBuy: z.string().default("0").describe("pair units for the creator's own first buy"),
    },
  },
  async (args) => {
    try {
      requireImageUrl(args.image);
      const c = ctx.client;
      const [available, config, econ] = await Promise.all([
        c.isSymbolAvailable(args.symbol),
        c.getConfig(args.configId),
        c.previewLaunchEconomics(args.configId, args.pairToken as Address),
      ]);
      if (!available) throw new Error(`ticker ${args.symbol} is locked right now: another launch is running hot with it`);
      if (!config.enabled) throw new Error(`preset ${args.configId} is disabled`);
      const firstBuy = args.firstBuy === "0" ? 0n : parseEther(args.firstBuy);
      return ok({
        plan: args,
        econ,
        preset: config,
        raiseAtGraduation: `${formatEther((config.graduationCap * BigInt(config.curveSupplyBps)) / 10_000n)} (approx, in pair units)`,
        firstBuy: firstBuy.toString(),
        feeSplitMeans: describeSplit(args),
        feeSplitAddsUp: args.stakersBps + args.buybackBps + args.liquidityBps + args.creatorBps === BPS,
        next: "hood_launch_token with the same arguments plus confirm: true",
      });
    } catch (e) { return fail(e); }
  },
);

/// What the split means in words, for a tool that has to explain itself before it spends money.
function describeSplit(split: { stakersBps: number; buybackBps: number; liquidityBps: number; creatorBps: number }): string {
  const legs: [number, string][] = [
    [split.stakersBps, FEE_LEG_LABEL.stakers], [split.buybackBps, FEE_LEG_LABEL.buyback],
    [split.liquidityBps, FEE_LEG_LABEL.liquidity], [split.creatorBps, FEE_LEG_LABEL.creator],
  ];
  const said = legs.filter(([bps]) => bps > 0).sort((a, b) => b[0] - a[0])
    .map(([bps, label]) => `${Math.round((bps / BPS) * 100)}% ${label.toLowerCase()}`);
  return said.length ? said.join(", ") : "nothing is allocated, which the factory refuses";
}

server.registerTool(
  "hood_launch_token",
  {
    description: "Prints the token and opens its curve. Sends a transaction.",
    inputSchema: {
      name: z.string(), symbol: z.string(), description: z.string().default(""),
      image: z.string().default(""), website: z.string().default(""), twitter: z.string().default(""),
      telegram: z.string().default(""),
      // Four legs in basis points that must add up to 10,000. An agent that hands over three of
      // them and expects the fourth to be inferred gets a refusal, not a guess.
      stakersBps: z.number().int().min(0).max(BPS).default(BPS),
      buybackBps: z.number().int().min(0).max(BPS).default(0),
      liquidityBps: z.number().int().min(0).max(BPS).default(0),
      creatorBps: z.number().int().min(0).max(BPS).default(0),
      firstBuyLock: z.number().int().min(0).default(0).describe("seconds the creator's own first buy is locked in the staking vault: 0, or one of 7, 30, 90, 180 days"),
      configId: z.number().default(0),
      pairToken: addr.default(zeroAddress),
      creatorFeeRecipient: addr.optional(),
      firstBuy: z.string().default("0"),
      confirm: z.boolean().optional(),
    },
  },
  async (args) => {
    try {
      ctx.requireSigner();
      ctx.requireConfirm(args.confirm, "hood_launch_token");
      requireImageUrl(args.image);
      const c = ctx.client;
      const { hash } = await c.launch({
        ...args,
        feeSplit: {
          stakersBps: args.stakersBps, buybackBps: args.buybackBps,
          liquidityBps: args.liquidityBps, creatorBps: args.creatorBps,
        },
        firstBuy: args.firstBuy === "0" ? 0n : parseEther(args.firstBuy),
        creatorFeeRecipient: args.creatorFeeRecipient as Address | undefined,
      });
      const { token, curve } = await c.launchResult(hash);
      return ok({ hash, token, curve, explorer: `https://robinhoodchain.blockscout.com/tx/${hash}` });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_buy",
  {
    description: "Buys off a curve with the unlocked wallet.",
    inputSchema: { token: addr, amount: z.string(), minTokensOut: z.string().optional(), confirm: z.boolean().optional() },
  },
  async ({ token, amount, minTokensOut, confirm }) => {
    try {
      ctx.requireSigner();
      ctx.requireConfirm(confirm, "hood_buy");
      const c = ctx.client;
      const launch = await c.getLaunch(token as Address);
      const pairDecimals = launch.pairToken === zeroAddress ? 18 : 6;
      const value = BigInt(Math.round(Number(amount) * 10 ** pairDecimals));
      const hash = await c.buy(launch.curve, value, { minTokensOut: minTokensOut ? BigInt(minTokensOut) : 0n });
      return ok({ hash });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_sell",
  {
    description: "Sells back into a curve with the unlocked wallet.",
    inputSchema: { token: addr, amount: z.string().describe("token amount, in whole tokens"), confirm: z.boolean().optional() },
  },
  async ({ token, amount, confirm }) => {
    try {
      ctx.requireSigner();
      ctx.requireConfirm(confirm, "hood_sell");
      const c = ctx.client;
      const launch = await c.getLaunch(token as Address);
      const hash = await c.sell(launch.curve, parseEther(amount));
      return ok({ hash });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_finalize",
  {
    description: "Opens the pool for a curve that sold out. Anyone may call it.",
    inputSchema: { token: addr, confirm: z.boolean().optional() },
  },
  async ({ token, confirm }) => {
    try {
      ctx.requireSigner();
      ctx.requireConfirm(confirm, "hood_finalize");
      const c = ctx.client;
      const launch = await c.getLaunch(token as Address);
      return ok({ hash: await c.finalize(launch.curve) });
    } catch (e) { return fail(e); }
  },
);

// ---------------------------------------------------------------- fees and staking

server.registerTool(
  "hood_get_creator_fees",
  {
    description: "What is booked for a token and waiting to be pushed through its fee model.",
    inputSchema: { token: addr },
  },
  async ({ token }) => {
    try {
      const c = ctx.client;
      const [launch, accrued] = await Promise.all([c.getLaunch(token as Address), c.creatorFees(token as Address)]);
      return ok({
        token, feeSplit: launch.feeSplit, feeSplitMeans: describeSplit({
          stakersBps: launch.feeSplit.stakersBps, buybackBps: launch.feeSplit.buybackBps,
          liquidityBps: launch.feeSplit.liquidityBps, creatorBps: launch.feeSplit.creatorBps,
        }),
        recipient: launch.creatorFeeRecipient, accrued,
        accruedPretty: formatEther(accrued),
        firstBuyLocked: launch.firstBuyLocked.toString(),
        firstBuyUnlockAt: launch.firstBuyUnlockAt,
        note: "pushing is permissionless: anyone can call hood_claim_fees, and the split decides where each part lands",
      });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_claim_fees",
  {
    description: "Pushes a token's booked fees through its model. Permissionless.",
    inputSchema: { token: addr, minTokensOut: z.string().optional().describe("required for a graduated buyback-and-burn token"), confirm: z.boolean().optional() },
  },
  async ({ token, minTokensOut, confirm }) => {
    try {
      ctx.requireSigner();
      ctx.requireConfirm(confirm, "hood_claim_fees");
      const c = ctx.client;
      const hash = minTokensOut
        ? await c.flushBuyback(token as Address, BigInt(minTokensOut))
        : await c.flush(token as Address);
      return ok({ hash });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_stake",
  {
    description: "Locks a token for the fee stream. Longer locks take a bigger share. Optionally locks it for somebody else (send a stake).",
    inputSchema: {
      token: addr, amount: z.string(),
      lockDays: z.number().default(0).describe("0, 7, 30, 90 or 180"),
      beneficiary: addr.optional(), confirm: z.boolean().optional(),
    },
  },
  async ({ token, amount, lockDays, beneficiary, confirm }) => {
    try {
      ctx.requireSigner();
      ctx.requireConfirm(confirm, "hood_stake");
      const hash = await ctx.client.stake(token as Address, parseEther(amount), lockDays * 86_400, beneficiary as Address | undefined);
      return ok({ hash, tiers: LOCK_TIERS });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_get_staking_positions",
  {
    description: "Staking positions and what they can claim. Reads the indexer when HOOD_API is set.",
    inputSchema: { owner: addr.optional(), ids: z.array(z.string()).optional() },
  },
  async ({ owner, ids }) => {
    try {
      if (ids?.length) {
        const positions = await Promise.all(ids.map((id) => ctx.client.getStakePosition(BigInt(id))));
        return ok({ positions });
      }
      const who = owner ?? ctx.signer?.address;
      if (!who) throw new Error("pass owner, or unlock a wallet");
      if (!ctx.apiUrl) throw new Error("listing by owner needs HOOD_API (the indexer); otherwise pass ids");
      const res = await fetch(new URL(`/stakes/${who}`, ctx.apiUrl));
      if (!res.ok) throw new Error(`indexer: ${res.status}`);
      return ok(await res.json());
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_claim_staking_rewards",
  {
    description: "Pays a staking position. Permissionless, and it always pays the position's owner.",
    inputSchema: { id: z.string(), unstake: z.boolean().default(false), confirm: z.boolean().optional() },
  },
  async ({ id, unstake, confirm }) => {
    try {
      ctx.requireSigner();
      ctx.requireConfirm(confirm, "hood_claim_staking_rewards");
      const c = ctx.client;
      const hash: Hash = unstake ? await c.unstake(BigInt(id)) : await c.claim(BigInt(id));
      return ok({ hash });
    } catch (e) { return fail(e); }
  },
);

// ---------------------------------------------------------------- omnichain

server.registerTool(
  "hood_bridge",
  {
    description: "Sends a launched token to another chain, or quotes what that costs.",
    inputSchema: {
      token: addr,
      route: z.enum(Object.keys(routes) as [string, ...string[]]),
      amount: z.string(),
      to: addr.optional(),
      quoteOnly: z.boolean().default(true),
      confirm: z.boolean().optional(),
    },
  },
  async ({ token, route, amount, to, quoteOnly, confirm }) => {
    try {
      const c = ctx.client;
      const value = parseEther(amount);
      if (quoteOnly) {
        const q = await c.bridgeQuote(token as Address, route as never, value, to as Address | undefined);
        return ok({ route, amount, fee: q.fee, adapter: q.adapter });
      }
      ctx.requireSigner();
      ctx.requireConfirm(confirm, "hood_bridge");
      return ok({ hash: await c.bridgeSend(token as Address, route as never, value, to as Address | undefined) });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_cross_chain_buy",
  {
    description:
      "Buys a hood.fam token with funds sitting on another chain, in one signature. Returns a Relay " +
      "quote when RELAY_API_KEY is set, and a hosted link when it is not.",
    inputSchema: {
      token: addr,
      fromChainId: z.number(),
      amount: z.string().describe("amount on the origin chain, in whole units"),
      user: addr.optional(),
    },
  },
  async ({ token, fromChainId, amount, user }) => {
    try {
      const c = ctx.client;
      const who = (user ?? ctx.signer?.address) as Address | undefined;
      const launch = await c.getLaunch(token as Address);
      if (!launch.exists) throw new Error("unknown token");
      if (!who) throw new Error("pass user, or unlock a wallet");
      const wei = parseEther(amount);
      if (!canQuoteCrossChain()) {
        return ok({
          mode: "hosted",
          link: crossChainBuyLink({ fromChainId, amount, recipient: who }),
          then: "once the funds land on 4663, call hood_buy",
        });
      }
      const call = {
        to: launch.curve,
        data: c.encodeBuyCall(launch.curve, wei, 0n, who),
        value: wei.toString(),
      };
      const quote = await quoteCrossChainBuy({ user: who, originChainId: fromChainId, amount: wei.toString(), call });
      return ok({ mode: "relay", quote });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_deploy_adapter",
  {
    description: "Deploys the one lock box that lets a token travel. Permissionless, once per token.",
    inputSchema: { token: addr, confirm: z.boolean().optional() },
  },
  async ({ token, confirm }) => {
    try {
      ctx.requireSigner();
      ctx.requireConfirm(confirm, "hood_deploy_adapter");
      return ok({ hash: await ctx.client.deployAdapter(token as Address) });
    } catch (e) { return fail(e); }
  },
);

// ---------------------------------------------------------------- the direct machine

server.registerTool(
  "hood_plan_direct_launch",
  {
    description:
      "Plans a launch with no curve: the whole supply goes into one Uniswap v4 position and a hook " +
      "taxes every trade. Converts valuations to ticks, checks the split adds up, and mines the " +
      "hook address. Sends nothing.",
    inputSchema: {
      name: z.string(), symbol: z.string(),
      openValuation: z.number().describe("what the token is worth at the open, in the quote asset"),
      bondValuation: z.number().describe("and what it is worth once it has bonded"),
      buyTaxPct: z.number().min(1).max(10).default(5),
      sellTaxPct: z.number().min(1).max(10).default(5),
      snipeTaxPct: z.number().min(0).max(89).default(50),
      snipeDecaySeconds: z.number().default(3),
      creatorPct: z.number().default(25),
      buybackPct: z.number().default(25),
      dividendsPct: z.number().default(40),
      liquidityPct: z.number().default(10),
      creator: addr.optional().describe("who will send the launch; the hook salt is bound to them. Defaults to the unlocked wallet"),
    },
  },
  async (a) => {
    try {
      const supply = 1_000_000_000;
      const spacing = 200;
      const sum = a.creatorPct + a.buybackPct + a.dividendsPct + a.liquidityPct;
      if (sum !== 100) throw new Error(`the four destinations must add up to 100, got ${sum}`);
      const tick = (fdv: number) => Math.round(Math.log(supply / fdv) / Math.log(1.0001) / spacing) * spacing;
      const who = (a.creator ?? ctx.signer?.address) as `0x${string}` | undefined;
      if (!who) throw new Error("pass creator, or unlock a wallet: the hook salt is bound to whoever sends the launch");
      const { salt, hook, attempts } = await ctx.direct.hookSalt(0n, who);
      return ok({
        plan: a,
        ticks: { tickStart: tick(a.openValuation), tickBond: tick(a.bondValuation) },
        hook: { address: hook, salt, attempts },
        launchFee: (await ctx.direct.launchFee()).toString(),
        next: "hood_launch_direct with the same arguments plus confirm: true",
      });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_launch_direct",
  {
    description: "Prints a direct launch: token, hook, splitter, locker and the pool, in one transaction.",
    inputSchema: {
      name: z.string(), symbol: z.string(), logo: z.string().default(""), description: z.string().default(""),
      openValuation: z.number(), bondValuation: z.number(),
      buyTaxPct: z.number().min(1).max(10).default(5),
      sellTaxPct: z.number().min(1).max(10).default(5),
      snipeTaxPct: z.number().min(0).max(89).default(50),
      snipeDecaySeconds: z.number().default(3),
      restrictionBlocks: z.number().default(30),
      creatorPct: z.number().default(25), buybackPct: z.number().default(25),
      dividendsPct: z.number().default(40), liquidityPct: z.number().default(10),
      firstBuy: z.string().default("0").describe("quote spent on the creator's own first buy, inside the launch"),
      confirm: z.boolean().optional(),
    },
  },
  async (a) => {
    try {
      ctx.requireSigner();
      ctx.requireConfirm(a.confirm, "hood_launch_direct");
      requireImageUrl(a.logo);
      const supply = 1_000_000_000;
      const spacing = 200;
      const tick = (fdv: number) => Math.round(Math.log(supply / fdv) / Math.log(1.0001) / spacing) * spacing;
      const { hash } = await ctx.direct.launch({
        name: a.name, symbol: a.symbol, logo: a.logo, description: a.description,
        buyTaxBps: Math.round(a.buyTaxPct * 100),
        sellTaxBps: Math.round(a.sellTaxPct * 100),
        snipeTaxBps: Math.round(a.snipeTaxPct * 100),
        snipeDecaySeconds: a.snipeDecaySeconds,
        restrictionBlocks: a.restrictionBlocks,
        tickStart: tick(a.openValuation),
        tickBond: tick(a.bondValuation),
        allocations: {
          creatorBps: a.creatorPct * 100, buybackBps: a.buybackPct * 100,
          dividendsBps: a.dividendsPct * 100, liquidityBps: a.liquidityPct * 100,
        },
        initialBuy: a.firstBuy === "0" ? 0n : parseEther(a.firstBuy),
      });
      return ok({ hash, explorer: `https://robinhoodchain.blockscout.com/tx/${hash}` });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_direct_info",
  {
    description: "A direct launch's live numbers: the tax right now, the snipe surcharge left, the four buckets, bonded or not.",
    inputSchema: { token: addr, account: addr.optional() },
  },
  async ({ token, account }) => {
    try {
      const d = ctx.direct;
      const launch = await d.getLaunch(token as Address);
      if (!launch.exists) throw new Error("not a direct launch");
      const [taxes, buckets, metadata, status, claims] = await Promise.all([
        d.taxes(launch.hook), d.buckets(launch.splitter), d.metadata(token as Address),
        d.graduationStatus(token as Address), d.claimsHeld(launch.hook),
      ]);
      const who = (account ?? ctx.signer?.address) as Address | undefined;
      return ok({
        launch, taxes, buckets, metadata, status, taxWaitingAsClaims: claims.toString(),
        yourDividends: who ? (await d.pendingDividends(launch.splitter, who)).toString() : null,
      });
    } catch (e) { return fail(e); }
  },
);

// A direct launch's pool is swapped through the UniversalRouter, and the router is told a floor
// from a fresh quote every time: a swap with no floor is a gift to whoever sees it first.
server.registerTool(
  "hood_direct_buy",
  {
    description: "Buys a direct launch on its v4 pool with the unlocked wallet. Quotes first and sends a floor under the quote.",
    inputSchema: {
      token: addr,
      amount: z.string().describe("quote amount, e.g. '0.5' ETH"),
      slippageBps: z.number().int().min(0).max(5_000).default(100).describe("how far under the quote the floor sits"),
      confirm: z.boolean().optional(),
    },
  },
  async ({ token, amount, slippageBps, confirm }) => {
    try {
      ctx.requireSigner();
      ctx.requireConfirm(confirm, "hood_direct_buy");
      const d = ctx.direct;
      const launch = await d.getLaunch(token as Address);
      if (!launch.exists) throw new Error("not a direct launch");
      const amountIn = parseUnits(amount, launch.quote === zeroAddress ? 18 : 6);
      const r = await d.swap({ token: token as Address, side: "buy", amountIn, slippageBps });
      return ok({ hash: r.hash, expectedOut: r.amountOut, minAmountOut: r.minAmountOut });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_direct_sell",
  {
    description: "Sells a direct launch's token on its v4 pool with the unlocked wallet. Quotes first and sends a floor under the quote; approves Permit2 and the router once, when missing.",
    inputSchema: {
      token: addr,
      amount: z.string().describe("token amount, in whole tokens"),
      slippageBps: z.number().int().min(0).max(5_000).default(100).describe("how far under the quote the floor sits"),
      confirm: z.boolean().optional(),
    },
  },
  async ({ token, amount, slippageBps, confirm }) => {
    try {
      ctx.requireSigner();
      ctx.requireConfirm(confirm, "hood_direct_sell");
      const r = await ctx.direct.swap({ token: token as Address, side: "sell", amountIn: parseEther(amount), slippageBps });
      return ok({ hash: r.hash, expectedOut: r.amountOut, minAmountOut: r.minAmountOut });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_claim_dividends",
  {
    description: "Pays a holder their share of a direct launch's tax. Permissionless: it always pays the holder.",
    inputSchema: { token: addr, account: addr.optional(), confirm: z.boolean().optional() },
  },
  async ({ token, account, confirm }) => {
    try {
      ctx.requireSigner();
      ctx.requireConfirm(confirm, "hood_claim_dividends");
      const d = ctx.direct;
      const launch = await d.getLaunch(token as Address);
      const who = (account ?? ctx.signer!.address) as Address;
      return ok({ hash: await d.claimDividends(launch.splitter, who) });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_run_buyback",
  {
    description: "Spends a direct launch's buyback pot and burns what it buys. Permissionless. The run is quoted first and sent with a floor under the quote.",
    inputSchema: {
      token: addr,
      minTokensOut: z.string().optional().describe("floor in token wei; when omitted it is quoted and set slippageBps under the quote"),
      slippageBps: z.number().int().min(0).max(5_000).default(100),
      confirm: z.boolean().optional(),
    },
  },
  async ({ token, minTokensOut, slippageBps, confirm }) => {
    try {
      ctx.requireSigner();
      ctx.requireConfirm(confirm, "hood_run_buyback");
      const d = ctx.direct;
      let floor = minTokensOut ? BigInt(minTokensOut) : undefined;
      if (floor === undefined) {
        const expected = await d.quoteBuyback(token as Address);
        if (expected === 0n) throw new Error("the buyback would buy nothing right now");
        floor = minOutFromQuote(expected, slippageBps);
      }
      return ok({ hash: await d.runBuyback(token as Address, floor), minTokensOut: floor });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_harvest_fees",
  {
    description: "Pulls what a direct launch's locked position earned and runs it through the same four roads.",
    inputSchema: { token: addr, confirm: z.boolean().optional() },
  },
  async ({ token, confirm }) => {
    try {
      ctx.requireSigner();
      ctx.requireConfirm(confirm, "hood_harvest_fees");
      const launch = await ctx.direct.getLaunch(token as Address);
      return ok({ hash: await ctx.direct.harvest(launch.locker) });
    } catch (e) { return fail(e); }
  },
);

// ---------------------------------------------------------------- wallets

server.registerTool(
  "hood_wallet_new",
  {
    description: "Creates a fresh encrypted wallet in the local keystore. The key never leaves this machine.",
    inputSchema: { label: z.string(), password: z.string().min(8), note: z.string().optional() },
  },
  async ({ label, password, note }) => {
    try { return ok(newWallet(label, password, note)); } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_wallet_import",
  {
    description: "Imports an existing private key into the local keystore, encrypted.",
    inputSchema: { label: z.string(), privateKey: z.string(), password: z.string().min(8), note: z.string().optional() },
  },
  async ({ label, privateKey, password, note }) => {
    try { return ok(importWallet(label, privateKey, password, note)); } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_wallet_unlock",
  {
    description: "Unlocks a keystore wallet for this session. Later write tools sign with it.",
    inputSchema: { label: z.string(), password: z.string() },
  },
  async ({ label, password }) => {
    try { return ok(ctx.unlock(label, password)); } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_wallet_list",
  { description: "Wallets in the local keystore, and which one is unlocked.", inputSchema: {} },
  async () => ok({ wallets: listWallets(), unlocked: ctx.signer ?? null, agentMode: ctx.agentMode }),
);

server.registerTool(
  "hood_wallet_remove",
  { description: "Forgets a keystore wallet.", inputSchema: { label: z.string(), confirm: z.boolean().optional() } },
  async ({ label, confirm }) => {
    try {
      ctx.requireConfirm(confirm, "hood_wallet_remove");
      removeWallet(label);
      return ok({ removed: label });
    } catch (e) { return fail(e); }
  },
);

// ---------------------------------------------------------------- treasury and gas

server.registerTool(
  "hood_set_treasury_wallet",
  {
    description: "Sets where this session drains funds to. Does not touch the protocol's own treasury.",
    inputSchema: { address: addr },
  },
  async ({ address }) => { ctx.treasury = address as Address; return ok({ treasury: ctx.treasury }); },
);

server.registerTool(
  "hood_fund_deployment_wallet",
  {
    description: "Sends gas from the unlocked wallet to another address, so an agent can keep working.",
    inputSchema: { to: addr, amount: z.string(), confirm: z.boolean().optional() },
  },
  async ({ to, amount, confirm }) => {
    try {
      const account = ctx.requireSigner();
      ctx.requireConfirm(confirm, "hood_fund_deployment_wallet");
      const hash = await ctx.walletClient!.sendTransaction({
        account, to: to as Address, value: parseEther(amount), chain: null,
      });
      return ok({ hash, to, amount });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_drain_deployment_wallet",
  {
    description: "Sweeps the unlocked wallet's native balance to the treasury, minus gas.",
    inputSchema: { to: addr.optional(), confirm: z.boolean().optional() },
  },
  async ({ to, confirm }) => {
    try {
      const account = ctx.requireSigner();
      ctx.requireConfirm(confirm, "hood_drain_deployment_wallet");
      const target = (to ?? ctx.treasury) as Address | undefined;
      if (!target) throw new Error("no destination: pass to, or call hood_set_treasury_wallet first");
      const pc = ctx.publicClient;
      const [balance, gasPrice] = await Promise.all([pc.getBalance({ address: account.address }), pc.getGasPrice()]);
      const reserve = gasPrice * 60_000n;
      if (balance <= reserve) throw new Error("balance does not cover the gas to move it");
      const hash = await ctx.walletClient!.sendTransaction({
        account, to: target, value: balance - reserve, chain: null,
      });
      return ok({ hash, to: target, sent: formatEther(balance - reserve) });
    } catch (e) { return fail(e); }
  },
);

// ---------------------------------------------------------------- signing without a key

server.registerTool(
  "hood_open_web_signer",
  {
    description:
      "Opens a local page where a human signs a prepared transaction in their own wallet. Use this " +
      "when no key should ever touch the agent. Returns a URL; poll hood_signer_status for the hash.",
    inputSchema: {
      to: addr, data: z.string().default("0x"), value: z.string().default("0"),
      label: z.string().default("hood.fam transaction"),
    },
  },
  async ({ to, data, value, label }) => {
    try {
      const tx = await signer.open({
        to: to as Address, data: data as `0x${string}`, value, chainId: 4663, label,
      });
      return ok({ id: tx.id, url: signer.url(tx.id), open: "paste this in a browser that has your wallet" });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "hood_signer_status",
  { description: "Whether a web-signer transaction was signed, and its hash.", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const tx = signer.get(id);
    return tx ? ok(tx) : fail(new Error("unknown signer id"));
  },
);

server.registerTool(
  "hood_sign_and_submit_evm",
  {
    description: "Signs and sends a raw transaction with the unlocked wallet.",
    inputSchema: { to: addr, data: z.string().default("0x"), value: z.string().default("0"), confirm: z.boolean().optional() },
  },
  async ({ to, data, value, confirm }) => {
    try {
      const account = ctx.requireSigner();
      ctx.requireConfirm(confirm, "hood_sign_and_submit_evm");
      const hash = await ctx.walletClient!.sendTransaction({
        account, to: to as Address, data: data as `0x${string}`, value: BigInt(value), chain: null,
      });
      return ok({ hash });
    } catch (e) { return fail(e); }
  },
);

// ---------------------------------------------------------------- art

server.registerTool(
  "hood_generate_image",
  {
    description:
      "Generates token art from a prompt, stores it, and returns the URL to pass as `image` to a launch. " +
      "The image itself comes back too, so the caller can look at it before launching.",
    inputSchema: { prompt: z.string(), model: z.string().optional(), style: z.string().optional() },
  },
  async ({ prompt, model, style }) => {
    try {
      const img = await generateImage({ prompt, model, style });
      // A launch writes `image` into calldata and into its event, so what this hands back has to be
      // a link. The bytes go to the API's bucket; when there is no API or no bucket the tool says
      // so rather than quietly handing back a data URI that would cost a fortune to launch with.
      const stored = await store(img.bytes, img.mimeType);
      return {
        content: [
          {
            type: "text" as const,
            text: json({ model: img.model, mimeType: img.mimeType, bytes: img.bytes.length, ...stored }),
          },
          { type: "image" as const, data: Buffer.from(img.bytes).toString("base64"), mimeType: img.mimeType },
        ],
      };
    } catch (e) { return fail(e); }
  },
);

/// Best effort by design: art that could not be stored is still art, and the caller is told exactly
/// what to do with it instead of being handed a data URI as if it were a URL.
async function store(bytes: Uint8Array, contentType: string) {
  if (!ctx.apiUrl) {
    return { url: null, stored: "no HOOD_API in the environment, so there is nowhere to put the bytes: pass a URL you host yourself as `image`" };
  }
  try {
    const up = await uploadImage({ apiUrl: ctx.apiUrl, bytes, contentType });
    return { url: up.url, deduped: up.deduped, next: "pass url as `image` to hood_create_token" };
  } catch (e) {
    const why = e instanceof ImageUploadError ? e.message : e instanceof Error ? e.message : String(e);
    return { url: null, stored: `not stored: ${why}. Pass a URL you host yourself as \`image\`` };
  }
}

await server.connect(new StdioServerTransport());
