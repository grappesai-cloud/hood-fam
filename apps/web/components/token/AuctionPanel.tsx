"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { erc20Abi, parseUnits, zeroAddress, type Address } from "viem";
import { useAccount, useBlockNumber, usePublicClient, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { BAG_KEYS, big, useAuction, type AuctionRow } from "@/lib/bag";
import { hoodOpeningAuctionAbi } from "@/lib/bagAbi";
import { bagAddresses } from "@/lib/config";
import { fmt, shortAddress } from "@/lib/format";
import { Prov } from "@/components/Provenance";

/// The opening auction. The first slot after the creator's block is for sale; the highest bid when
/// the window ends buys it, half of what it paid goes to the holders and half into locked
/// liquidity. Bids are in the launch's quote (sent as value when that is the chain's own currency,
/// pulled after an approval otherwise) and each has to beat the last by 5%. The outbid bidder is
/// refunded on the spot; a refund that could not be delivered is booked and claimed from here.
///
/// The slot itself does not wait for a settle: it starts the block after the window and lasts
/// SLOT_BLOCKS, and the token reads the bid book. Settling moves the money. Rendered only while
/// the indexer says an auction exists: a launch that opened fair has no panel.

const STEP_BPS = 500n;

/// The route spreads the launch's quote onto the row; the shared type does not name those fields.
type AuctionApiRow = AuctionRow & {
  asset?: string | null; symbol?: string | null; decimals?: number | null; auction_blocks?: number | null;
};

interface Book {
  quote: Address; splitter: Address; locker: Address; endBlock: bigint; minBid: bigint;
  bidder: Address; amount: bigint; settled: boolean;
}

export function AuctionPanel({ token }: { token: Address }) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();
  const contract = bagAddresses.openingAuction;
  const query = useAuction(token);
  const row = query.data && (query.data as { enabled?: boolean }).enabled !== false ? (query.data as AuctionApiRow) : null;
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string>();
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const [busy, setBusy] = useState<string>();
  const { writeContractAsync } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });
  const { data: head } = useBlockNumber({ watch: true, query: { enabled: Boolean(row) } });

  // The book, the floor, the settled winner and the slot length, straight from the contract when
  // the deployment has one wired; the indexer's row otherwise.
  const { data: onChain, refetch: refetchBook } = useReadContracts({
    contracts: [
      { address: contract, abi: hoodOpeningAuctionAbi, functionName: "auctionOf", args: [token] },
      { address: contract, abi: hoodOpeningAuctionAbi, functionName: "minimumBid", args: [token] },
      { address: contract, abi: hoodOpeningAuctionAbi, functionName: "firstSlot", args: [token] },
      { address: contract, abi: hoodOpeningAuctionAbi, functionName: "SLOT_BLOCKS" },
    ],
    query: { enabled: Boolean(contract) && Boolean(row), refetchInterval: 4_000 },
  });
  const chain = (onChain ?? []) as { result?: unknown; status?: string }[];
  const chainOk = chain.length === 4 && chain.every((c) => c.status === "success");
  const book = chainOk ? (chain[0]!.result as Book) : null;

  const quote = (book?.quote ?? (row?.asset as Address | undefined) ?? zeroAddress) as Address;
  const native = quote === zeroAddress;
  const decimals = row?.decimals ?? 18;
  const symbol = row?.symbol ?? (native ? "ETH" : "the quote");

  // This wallet's booked refund and, for an ERC-20 quote, what it has let the auction pull.
  const { data: mine, refetch: refetchMine } = useReadContracts({
    contracts: [{ address: contract, abi: hoodOpeningAuctionAbi, functionName: "refunds", args: [quote, address ?? zeroAddress] }],
    query: { enabled: Boolean(contract) && Boolean(row) && Boolean(address), refetchInterval: 6_000 },
  });
  const { data: allowed, refetch: refetchAllowance } = useReadContracts({
    contracts: [{ address: quote, abi: erc20Abi, functionName: "allowance", args: [address ?? zeroAddress, contract ?? zeroAddress] }],
    query: { enabled: Boolean(contract) && Boolean(row) && Boolean(address) && !native, refetchInterval: 6_000 },
  });
  const mineRows = (mine ?? []) as { result?: unknown; status?: string }[];
  const allowedRows = (allowed ?? []) as { result?: unknown; status?: string }[];
  const refund: bigint = mineRows[0]?.status === "success" ? (mineRows[0].result as bigint) : 0n;
  const allowance: bigint = !native && allowedRows[0]?.status === "success" ? (allowedRows[0].result as bigint) : 0n;

  useEffect(() => {
    if (!receipt.isSuccess) return;
    void queryClient.invalidateQueries({ queryKey: BAG_KEYS.auction(token) });
    void queryClient.invalidateQueries({ queryKey: BAG_KEYS.pot(token) });
    void refetchBook();
    void refetchMine();
    void refetchAllowance();
  }, [receipt.isSuccess, queryClient, token, refetchBook, refetchMine, refetchAllowance]);

  if (!row) return null;

  const topBid: bigint = book ? book.amount : big(row.top_bid);
  const topBidder: string | null = book ? (book.bidder === zeroAddress ? null : book.bidder) : row.top_bidder;
  const endBlock: bigint = book ? BigInt(book.endBlock) : big(row.end_block);
  const settled: boolean = book ? book.settled : row.settled;
  const minimum: bigint = chainOk ? (chain[1]!.result as bigint) : topBid > 0n ? topBid + (topBid * STEP_BPS) / 10_000n : 0n;
  const slotBlocks: bigint = chainOk ? BigInt(chain[3]!.result as bigint) : 20n;
  const firstSlot: string | null = chainOk
    ? ((chain[2]!.result as Address) === zeroAddress ? null : (chain[2]!.result as string))
    : row.winner && row.winner !== zeroAddress ? row.winner : null;
  // The contract takes bids through the end block and settles from the one after it.
  const closed = head != null && endBlock > 0n && head > endBlock;
  const blocksLeft = head != null && endBlock > head ? endBlock - head : 0n;
  const slotEnd = endBlock + slotBlocks;
  const slotRunning = closed && head != null && head <= slotEnd;
  const slotHolder = settled ? firstSlot : topBidder;

  const wei = (() => { try { return parseUnits(amount || "0", decimals); } catch { return 0n; } })();
  const tooLow = wei === 0n || wei < minimum;
  const needsApproval = !native && wei > 0n && allowance < wei;
  const working = Boolean(busy) || receipt.isLoading;
  const money = (v: bigint) => `${fmt(v, decimals, 5)} ${symbol}`;

  async function run(label: string, fn: () => Promise<`0x${string}`>) {
    if (!contract) return;
    setError(undefined);
    setBusy(label);
    try {
      setHash(await fn());
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      setError(err.shortMessage ?? err.message ?? String(e));
    } finally {
      setBusy(undefined);
    }
  }

  // An ERC-20 quote is pulled by the auction, so it has to be allowed first: exactly the bid, and
  // the bid only goes out once the allowance is mined. A native quote rides along as value.
  const bid = () => run(needsApproval ? "approving" : "bidding", async () => {
    if (needsApproval) {
      const approval = await writeContractAsync({ address: quote, abi: erc20Abi, functionName: "approve", args: [contract!, wei] });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash: approval });
      setBusy("bidding");
    }
    return writeContractAsync({
      address: contract!, abi: hoodOpeningAuctionAbi, functionName: "bid", args: [token, wei], value: native ? wei : 0n,
    });
  });
  const settle = () => run("settling", () =>
    writeContractAsync({ address: contract!, abi: hoodOpeningAuctionAbi, functionName: "settle", args: [token] }));
  const claimRefund = () => run("claiming", () =>
    writeContractAsync({ address: contract!, abi: hoodOpeningAuctionAbi, functionName: "claimRefund", args: [quote] }));

  return (
    <div className={`panel auction-panel p-4${closed ? " closed" : ""}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-semibold">Opening auction</h3>
        <span className="mono dim text-xs">{row.bids} bid{row.bids === 1 ? "" : "s"}</span>
      </div>
      <p className="mt-1 text-xs dim">
        The first slot after the creator&apos;s block is for sale. The winner buys first; half of what they pay goes to the holders, half into locked liquidity.
      </p>

      <div className="auction-figures">
        <div>
          <div className="mono text-sm">{topBid > 0n ? money(topBid) : <span className="figure-dash">—</span>}</div>
          <div className="dim text-xs">{topBid > 0n ? <>{settled ? "paid" : "top bid"} <Prov kind="measured" /></> : "no bid yet"}</div>
        </div>
        <div>
          <div className="mono text-sm">
            {slotHolder ? <Link href={`/portfolio?address=${slotHolder}`}>{shortAddress(slotHolder)}</Link> : <span className="figure-dash">—</span>}
          </div>
          <div className="dim text-xs">{settled ? (slotHolder ? "bought the first slot" : "nobody bid") : slotHolder ? (closed ? "has the slot" : "is winning") : "nobody bidding"}</div>
        </div>
        <div>
          <div className="mono text-sm">{endBlock > 0n ? `#${endBlock.toString()}` : <span className="figure-dash">—</span>}</div>
          <div className="dim text-xs">
            {closed ? "window closed at this block" : head != null && blocksLeft > 0n ? `${blocksLeft.toString()} blocks to go` : "end block"}
          </div>
        </div>
      </div>

      {!contract ? (
        <p className="text-xs dim">The auction contract is not wired on this deployment, so this page can only watch it.</p>
      ) : settled ? (
        <p className="text-xs dim">
          {firstSlot
            ? <>Settled. {shortAddress(firstSlot)} paid {money(topBid)} for the first slot, blocks #{(endBlock + 1n).toString()} to #{slotEnd.toString()}{slotRunning ? " (running now)" : ""}: half went to the holders, half into locked liquidity.</>
            : <>Settled with no bids. Nothing was sold and the pool opened after block #{endBlock.toString()}.</>}
        </p>
      ) : closed ? (
        <>
          <p className="text-xs dim">
            {topBidder
              ? <>The window has closed. {shortAddress(topBidder)} has the first slot, blocks #{(endBlock + 1n).toString()} to #{slotEnd.toString()}{slotRunning ? " (running now)" : ""}, whether or not anyone has settled. Settling moves the money: half the bid to the holders, half into locked liquidity.</>
              : <>The window has closed with no bids. Nothing is sold and the pool opens as it would have; settling only closes the book.</>}
          </p>
          <button className="btn mt-2 w-full text-sm" disabled={!address || working} onClick={settle}>
            {busy === "settling" || receipt.isLoading ? "settling" : "settle the auction (anyone can)"}
          </button>
        </>
      ) : (
        <div className="auction-form">
          <label className="text-xs dim" htmlFor="auction-bid">
            {topBid > 0n
              ? `Your bid has to beat the top one by 5%: at least ${money(minimum)}.`
              : minimum > 0n
                ? `You bid in ${symbol}. The first bid has to be at least ${money(minimum)}; the next has to beat it by 5%.`
                : `You bid in ${symbol}. The next bidder has to beat you by 5%.`}
          </label>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <input id="auction-bid" className="input" inputMode="decimal" placeholder={minimum > 0n ? fmt(minimum, decimals, 5) : "0.05"}
              value={amount} onChange={(e) => setAmount(e.target.value)} />
            <button className="btn text-xs" disabled={!address || tooLow || working} onClick={bid}>
              {busy === "approving" ? "approving" : busy === "bidding" || receipt.isLoading ? "bidding" : needsApproval ? `approve and bid` : "bid"}
            </button>
          </div>
          {address && amount && tooLow && <p className="text-xs dim">That is under the minimum.</p>}
          {address && !tooLow && needsApproval && <p className="text-xs dim">Two signatures: one lets the auction pull {money(wei)}, the second bids it.</p>}
          {!address && <p className="text-xs dim">Connect a wallet to bid.</p>}
          <p className="text-xs dim">You get outbid, you get your {symbol} back. You win, you buy first and pay the holders half.</p>
        </div>
      )}

      {contract && address && refund > 0n && (
        <div className="mt-2">
          <p className="text-xs dim">A refund of {money(refund)} could not be delivered to your wallet and is booked for you.</p>
          <button className="btn btn-ghost mt-1 w-full text-xs" disabled={working} onClick={claimRefund}>
            {busy === "claiming" ? "claiming" : "claim your refund"}
          </button>
        </div>
      )}

      {error && <p className="mt-2 break-words text-xs text-[var(--color-red)]">{error}</p>}
      {receipt.isSuccess && <p className="mt-2 text-xs text-[var(--color-lime)]">Sent and mined.</p>}
    </div>
  );
}
