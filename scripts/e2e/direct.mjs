// End to end for BOTH machines on a fork of 4663: the curve (launch, trade, graduate) and the
// direct machine (launch with a first buy, trade through the real router, flush claims, sweep,
// claim dividends, buy back, harvest). Everything the indexer has to understand happens here.
import { createPublicClient, createWalletClient, http, parseEther, zeroAddress, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createHoodClient, createDirectClient, robinhood, uniswapV4 } from "../../packages/sdk/dist/index.js";
import { buildSwap, universalRouterAbi } from "./swap.mjs";

const RPC = "http://127.0.0.1:8545";
const env = (k) => { const v = process.env[k]; if (!v) throw new Error(`missing ${k}`); return v; };
const addresses = {
  factory: env("HOOD_FACTORY"), feeRouter: env("HOOD_FEE_ROUTER"), staking: env("HOOD_STAKING"),
  graduator: env("HOOD_GRADUATOR"), bridgeFactory: env("HOOD_BRIDGE_FACTORY"),
};
const direct = { portal: env("HOOD_PORTAL"), deployer: env("HOOD_DIRECT_DEPLOYER"), buybackModule: env("HOOD_BUYBACK_MODULE") };

const keys = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];
const chain = { ...robinhood, rpcUrls: { default: { http: [RPC] } } };
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const who = keys.map((k) => {
  const account = privateKeyToAccount(k);
  const walletClient = createWalletClient({ account, chain, transport: http(RPC) });
  return {
    account,
    walletClient,
    hood: createHoodClient({ publicClient, walletClient, addresses }),
    direct: createDirectClient({ publicClient, walletClient, addresses: direct }),
  };
});
const [creator, alice, bob] = who;
// A receipt with status "reverted" is a failure, and a script that shrugs at it is not a test.
const wait = async (hash) => {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return receipt;
};
const erc20 = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }];
const balanceOf = (token, a) => publicClient.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [a] });
const mine = (n) => publicClient.request({ method: "anvil_mine", params: [`0x${n.toString(16)}`] });

// ---------------------------------------------------------------- the curve
console.log("curve: launching");
const { hash: curveHash } = await creator.hood.launch({ name: "Curve Fam", symbol: "CFAM", feeSplit: { stakersBps: 10_000, buybackBps: 0, liquidityBps: 0, creatorBps: 0 }, firstBuy: parseEther("0.2") });
const { token: cToken, curve } = await creator.hood.launchResult(curveHash);
await wait(await alice.hood.buy(curve, parseEther("0.5")));
await wait(await bob.hood.buy(curve, parseEther("0.4")));
const aliceBal = await balanceOf(cToken, alice.account.address);
await wait(await alice.hood.sell(curve, aliceBal / 4n));
const st = await creator.hood.getCurveState(curve);
const { pairIn } = await creator.hood.quoteBuyExactOut(curve, st.remaining);
await wait(await bob.hood.buyExactOut(curve, st.remaining, pairIn * 2n));
await wait(await bob.hood.finalize(curve));
console.log(`curve: ${cToken} graduated`);

// ---------------------------------------------------------------- the direct machine
console.log("direct: launching with a first buy");
const supply = 1_000_000_000, spacing = 200;
const tick = (fdv) => Math.round(Math.log(supply / fdv) / Math.log(1.0001) / spacing) * spacing;
const { hash: dHash } = await creator.direct.launch({
  name: "Direct Fam", symbol: "DFAM", logo: "ipfs://dfam", description: "the supply is the liquidity",
  socials: { twitter: "@dfam", telegram: "", discord: "", website: "https://hood.fam", farcaster: "" },
  tickStart: tick(10), tickBond: tick(100), restrictionBlocks: 5, initialBuy: parseEther("0.2"),
});
const dReceipt = await wait(dHash);
const dLog = dReceipt.logs.find((l) => l.address.toLowerCase() === direct.portal.toLowerCase() && l.topics.length >= 4);
const dToken = `0x${dLog.topics[1].slice(26)}`;
const launch = await creator.direct.getLaunch(dToken);
console.log(`direct: ${dToken} hook=${launch.hook} splitter=${launch.splitter}`);
console.log(`direct: creator holds ${formatEther(await balanceOf(dToken, creator.account.address))} from the first buy`);

await mine(6); // past the opening window
const key = { currency0: zeroAddress, currency1: dToken, fee: 10_000, tickSpacing: 200, hooks: launch.hook };
async function swapIn(w, amountIn) {
  const { commands, inputs } = buildSwap({ key, zeroForOne: true, amountIn, minAmountOut: 0n, tokenIn: zeroAddress, tokenOut: dToken });
  // A hooked pool's gas moves with the clock: the snipe surcharge decays between the estimate and
  // the block that executes it. Wallets pad estimates; a script has to pad its own.
  const args = [commands, inputs, BigInt(Math.floor(Date.now() / 1000) + 3600)];
  const estimate = await publicClient.estimateContractGas({
    address: uniswapV4.universalRouter, abi: universalRouterAbi, functionName: "execute", args, value: amountIn, account: w.account,
  });
  const hash = await w.walletClient.writeContract({
    address: uniswapV4.universalRouter, abi: universalRouterAbi, functionName: "execute",
    args, value: amountIn, gas: (estimate * 13n) / 10n,
  });
  await wait(hash);
  console.log(`direct: ${w.account.address.slice(0, 8)} bought with ${formatEther(amountIn)} ETH -> ${hash.slice(0, 12)}`);
}
await swapIn(alice, parseEther("1"));
await swapIn(bob, parseEther("2"));
console.log(`direct: tax waiting as claims ${formatEther(await creator.direct.claimsHeld(launch.hook))}`);
await wait(await bob.direct.flushClaims(launch.hook));
await wait(await bob.direct.sweep(launch.splitter));
const buckets = await creator.direct.buckets(launch.splitter);
console.log(`direct: buckets creator=${formatEther(buckets.creatorClaimable)} buyback=${formatEther(buckets.buybackPot)} liquidity=${formatEther(buckets.liquidityPot)} dividends=${formatEther(buckets.dividendsHeld)}`);
console.log(`direct: alice pending dividends ${formatEther(await creator.direct.pendingDividends(launch.splitter, alice.account.address))}`);
await wait(await bob.direct.claimDividends(launch.splitter, alice.account.address));
await wait(await creator.direct.claimCreator(launch.splitter, creator.account.address));
await wait(await bob.direct.runBuyback(dToken, 1n));
await wait(await bob.direct.pushLiquidity(launch.splitter));
await wait(await bob.direct.deepen(launch.locker));
await wait(await bob.direct.harvest(launch.locker));
const status = await creator.direct.graduationStatus(dToken);
console.log(`direct: status tick=${status.currentTick} bond=${status.bondTick} progress=${status.progressBps}bps bonded=${status.bonded}`);

console.log("\nE2E OK");
console.log(JSON.stringify({ curve: { token: cToken, curve }, direct: { token: dToken, ...launch } }, (_, v) => typeof v === "bigint" ? v.toString() : v, 1));
