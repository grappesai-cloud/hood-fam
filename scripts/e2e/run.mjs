// End to end on the local fork: launch three tokens, trade them, graduate one.
import { createPublicClient, createWalletClient, http, parseEther, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createHoodClient, robinhood } from "../../packages/sdk/dist/index.js";

const RPC = "http://127.0.0.1:8545";
const addresses = {
  factory: process.env.HOOD_FACTORY,
  feeRouter: process.env.HOOD_FEE_ROUTER,
  staking: process.env.HOOD_STAKING,
  graduator: process.env.HOOD_GRADUATOR,
  bridgeFactory: process.env.HOOD_BRIDGE_FACTORY,
};

const keys = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];
const chain = { ...robinhood, rpcUrls: { default: { http: [RPC] } } };
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const clients = keys.map((k) => {
  const account = privateKeyToAccount(k);
  const walletClient = createWalletClient({ account, chain, transport: http(RPC) });
  return { account, hood: createHoodClient({ publicClient, walletClient, addresses }) };
});

const [creator, alice, bob] = clients;
const wait = (hash) => publicClient.waitForTransactionReceipt({ hash });

const specs = [
  { name: "Hood Fam", symbol: "FAM", feeModel: "staking", description: "the fam takes the fee" },
  { name: "Burn Baby", symbol: "BURN", feeModel: "buyback", description: "every fee burns supply" },
  { name: "Deep Pool", symbol: "DEEP", feeModel: "liquidity", description: "fees deepen the pool" },
];

const launched = [];
for (const spec of specs) {
  const { hash } = await creator.hood.launch({ ...spec, image: "", firstBuy: parseEther("0.2") });
  const { token, curve } = await creator.hood.launchResult(hash);
  launched.push({ ...spec, token, curve });
  console.log(`launched ${spec.symbol} token=${token} curve=${curve}`);
}

// trade
for (const [i, l] of launched.entries()) {
  await wait(await alice.hood.buy(l.curve, parseEther(String(0.5 + i * 0.3))));
  await wait(await bob.hood.buy(l.curve, parseEther("0.4")));
  const bal = await publicClient.readContract({
    address: l.token, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "balanceOf", args: [alice.account.address],
  });
  await wait(await alice.hood.sell(l.curve, bal / 4n));
  console.log(`traded ${l.symbol}`);
}

// stake into the staking-model token
const fam = launched[0];
const famBal = await publicClient.readContract({
  address: fam.token, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
  functionName: "balanceOf", args: [bob.account.address],
});
await wait(await bob.hood.stake(fam.token, famBal / 2n, 30 * 86400));
console.log(`staked ${famBal / 2n} FAM for 30 days`);

// push the fees through the model
await wait(await creator.hood.flush(fam.token));
console.log("flushed FAM fees to stakers");

// graduate DEEP: buy the rest of the curve, then open the pool
const deep = launched[2];
const state = await creator.hood.getCurveState(deep.curve);
const { pairIn } = await creator.hood.quoteBuyExactOut(deep.curve, state.remaining);
await wait(await bob.hood.buyExactOut(deep.curve, state.remaining, pairIn * 2n));
await wait(await bob.hood.finalize(deep.curve));
console.log(`graduated DEEP, pool opened`);

// bridge: deploy the lock box for FAM
await wait(await creator.hood.deployAdapter(fam.token));
console.log(`lock box for FAM: ${await creator.hood.adapterOf(fam.token)}`);

console.log("\nE2E OK");
console.log(JSON.stringify(launched.map(({ symbol, token, curve }) => ({ symbol, token, curve })), null, 1));
