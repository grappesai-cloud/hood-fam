// The quote maths against closed forms, with no chain. At tick zero (sqrtP = 2^96) a range with
// liquidity L turns an input x into L * x / (L + x) of the other side, so every case here can be
// checked by hand. Build the sdk first: npx tsc -p packages/sdk/tsconfig.json
import { estimateSingleRangeSwap, minOutFromQuote } from "../../packages/sdk/dist/quote.js";

const Q96 = 1n << 96n;
const L = 10n ** 21n;
const ETH = 10n ** 18n;
const closedForm = (x) => (L * x) / (L + x);

let failures = 0;
function check(name, got, want, tolerance = 2n) {
  const diff = got > want ? got - want : want - got;
  const ok = diff <= tolerance;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: got ${got} want ${want}${diff ? ` (off by ${diff})` : ""}`);
}

// 1. buy 1 ETH into token1 at tick zero, no fee, no tax
{
  const r = estimateSingleRangeSwap({ sqrtPriceX96: Q96, liquidity: L, feePips: 0, zeroForOne: true, amountIn: ETH });
  check("buy, no fee, no tax", r.amountOut, closedForm(ETH));
  check("buy uses the whole input", r.amountInUsed, ETH, 0n);
  if (r.exhausted) { failures++; console.log("FAIL buy should not be exhausted"); }
}

// 2. the pool fee comes off first: 1% of the input never reaches the curve
{
  const r = estimateSingleRangeSwap({ sqrtPriceX96: Q96, liquidity: L, feePips: 10_000, zeroForOne: true, amountIn: ETH });
  const net = (ETH * 990_000n) / 1_000_000n;
  check("buy, 1% pool fee", r.amountOut, closedForm(net));
  check("fee amount", r.feeAmount, ETH - net, 0n);
}

// 3. a 5% buy tax comes off before the fee: (x - 5%) - 1% of that
{
  const r = estimateSingleRangeSwap({
    sqrtPriceX96: Q96, liquidity: L, feePips: 10_000, zeroForOne: true, amountIn: ETH, tax: { bps: 500, side: "input" },
  });
  const afterTax = ETH - (ETH * 500n) / 10_000n;
  const net = (afterTax * 990_000n) / 1_000_000n;
  check("buy, 5% tax then 1% fee", r.amountOut, closedForm(net));
  check("tax amount", r.taxAmount, ETH - afterTax, 0n);
  check("everything is accounted", r.amountInUsed, ETH, 0n);
}

// 4. a sell: token1 in, token0 out, the tax off the output
{
  const y = ETH;
  const r = estimateSingleRangeSwap({
    sqrtPriceX96: Q96, liquidity: L, feePips: 0, zeroForOne: false, amountIn: y, tax: { bps: 500, side: "output" },
  });
  const gross = closedForm(y);
  const want = gross - (gross * 500n) / 10_000n;
  check("sell, 5% tax off the output", r.amountOut, want, 4n);
}

// 5. an impact cap: the swap stops 1.5% down in sqrt price and leaves the rest of the input
{
  const limit = (Q96 * 985n) / 1000n;
  const r = estimateSingleRangeSwap({
    sqrtPriceX96: Q96, liquidity: L, feePips: 0, zeroForOne: true, amountIn: 100n * ETH, sqrtPriceLimitX96: limit,
  });
  check("capped output is the range's token1 down to the limit", r.amountOut, (L * (Q96 - limit)) / Q96);
  const needed = ((L << 96n) * (Q96 - limit)) / limit / Q96;
  check("capped input is what reaches the limit", r.amountInUsed, needed, 2n);
  if (!r.exhausted) { failures++; console.log("FAIL capped swap should be exhausted"); }
  if (r.sqrtPriceAfterX96 !== limit) { failures++; console.log("FAIL capped swap should stop at the limit"); }
}

// 6. a buy's output sold straight back never returns more than went in
{
  const buy = estimateSingleRangeSwap({ sqrtPriceX96: Q96, liquidity: L, feePips: 10_000, zeroForOne: true, amountIn: ETH });
  const sell = estimateSingleRangeSwap({
    sqrtPriceX96: buy.sqrtPriceAfterX96, liquidity: L, feePips: 10_000, zeroForOne: false, amountIn: buy.amountOut,
  });
  if (sell.amountOut >= ETH) { failures++; console.log(`FAIL round trip made money: ${sell.amountOut}`); }
  else console.log(`ok   round trip loses the fees: ${ETH - sell.amountOut} wei`);
}

// 7. the floor under a quote
check("1% under 1e6", minOutFromQuote(1_000_000n, 100), 990_000n, 0n);
check("5% under 1e18", minOutFromQuote(ETH, 500), (ETH * 95n) / 100n, 0n);
check("zero stays zero", minOutFromQuote(0n, 100), 0n, 0n);
for (const bad of [-1, 10_001, 1.5]) {
  try { minOutFromQuote(ETH, bad); failures++; console.log(`FAIL slippage ${bad} accepted`); }
  catch { console.log(`ok   slippage ${bad} rejected`); }
}

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log("quote maths: all checks passed");
