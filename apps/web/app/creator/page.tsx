"use client";

import Link from "next/link";
import { Empty } from "@/components/Empty";
import { usePreferredConnector } from "@/lib/safe";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { erc20Abi, zeroAddress, type Address } from "viem";
import { useAccount, useBalance, useConnect, useReadContract, useReadContracts } from "wagmi";
import {
  hoodFactoryAbi, hoodFeeRouterAbi, hoodLockerAbi, hoodRevenueSplitterAbi, uniswapV4GraduatorAbi,
} from "@hood/sdk";
import { api, type TokenRow } from "@/lib/api";
import { addresses } from "@/lib/config";
import { Artwork } from "@/components/Artwork";
import { Addr, ConfirmButton, Row } from "@/components/admin/ui";
import { AddressInput, deployedAt, same, useOwnerWrite, validAddress, WriteError } from "@/components/admin/owner";
import {
  compact, fmt, imageUrl, launchProgress, pairDecimals, pairSymbol, shortAddress, splitLabel,
} from "@/lib/format";

/// The page a creator comes back to. The token page is written for whoever is thinking about
/// buying; this one is written for whoever printed the thing: what each launch is worth, where it
/// stands, and the handful of transactions that are theirs to send. Most of those transactions are
/// permissionless, so the point of gathering them here is not permission, it is that nobody goes
/// looking for them on a block explorer.
///
/// Every button says why it cannot be pressed instead of simply going grey: a wallet that is not
/// the one being paid, an address this deployment never configured, or nothing waiting to move.

export default function CreatorPage() {
  const { address, isConnected } = useAccount();
  const { connect, isPending } = useConnect();
  const connector = usePreferredConnector();

  const { data, isError } = useQuery({
    queryKey: ["creator-launches", address],
    queryFn: () => api<{ tokens: TokenRow[] }>(`/tokens?creator=${address}&limit=100`),
    enabled: Boolean(address),
  });

  const intro = (
    <header className="page-intro">
      <div className="section-kicker">WALLET / CREATOR</div>
      <h1>Your launches</h1>
      <p>What this wallet printed, what it is worth now, and the transactions that are yours to send.</p>
    </header>
  );

  if (!isConnected || !address) {
    return (
      <div className="creator-shell">
        {intro}
        <section>
          <Empty
            title="Collect what your launches have earned."
            body="Connect the wallet that printed them and you get every launch on one page, what each one is worth right now, and one button for each payment that is sitting there waiting to be moved."
            action={
              <button className="btn" disabled={isPending || !connector}
                onClick={() => connector && connect({ connector })}>
                {isPending ? "Connecting…" : "Connect"}
              </button>
            }
          />
        </section>
      </div>
    );
  }

  if (isError) return (
    <div className="creator-shell">{intro}
      <div><Empty title="Launches unavailable." body="The indexer is not answering. Your launches appear here when it reconnects, and nothing on chain has changed." /></div>
    </div>
  );
  if (!data) return <div className="creator-shell">{intro}<div className="panel portfolio-loading">Loading your launches…</div></div>;
  if (data.tokens.length === 0) return (
    <div className="creator-shell">{intro}
      <section>
        <Empty title="This wallet has printed nothing yet."
          body="Print one and it shows up here the moment the indexer sees the block."
          action={<Link className="btn" href="/launch">Create a token</Link>} />
      </section>
    </div>
  );

  // What this wallet's launches are worth, added up, and how many have made it into a pool. The
  // page used to open on a count and nothing else.
  const worth = data.tokens.reduce((sum, t) => sum + (BigInt(t.price || "0") * BigInt(t.total_supply || "0")) / 10n ** 18n, 0n);
  const traded = data.tokens.reduce((sum, t) => sum + BigInt(t.volume_total || "0"), 0n);
  const inPool = data.tokens.filter((t) => t.mode === "direct" || t.status === "graduated" || t.bonded).length;

  return (
    <div className="creator-shell">
      <div className="page-head">
        {intro}
        <div className="head-figure">
          <strong>{compact(worth)} ETH</strong>
          <span>everything you printed, at the last trade</span>
        </div>
      </div>

      <div className="market-summary" aria-label="This wallet's launches">
        <div className="stat"><strong>{data.tokens.length}</strong><span>launches</span></div>
        <div className="stat"><strong>{inPool}</strong><span>in a pool</span></div>
        <div className="stat"><strong>{compact(traded)}</strong><span>ETH traded through them</span></div>
        <div className="stat"><strong className="mono">{shortAddress(address)}</strong><span>signing as</span></div>
      </div>

      <div className="creator-list">
        {data.tokens.map((t) => <Launch key={t.token} t={t} me={address} />)}
      </div>
    </div>
  );
}

function Launch({ t, me }: { t: TokenRow; me: Address }) {
  const { send, pending, error, writeContractAsync } = useOwnerWrite();
  const [handover, setHandover] = useState("");

  const feeRouter = deployedAt(addresses.feeRouter);
  const factory = deployedAt(addresses.factory);
  const graduator = deployedAt(addresses.graduator);

  const direct = t.mode === "direct";
  const graduated = t.status === "graduated" || t.bonded;
  const dec = pairDecimals(t.pair_token, t);
  const sym = pairSymbol(t.pair_token, t);
  const progress = launchProgress(t);
  const isCreator = same(t.creator, me);
  // The creator leg pays a wallet, which is what makes the flush their claim and the recipient
  // something they can hand over.
  const keeps = !direct && (t.split_creator_bps ?? 0) > 0;
  // Any part of the fee that buys back has to swap, and a swap after graduation needs a price floor.
  const buysBack = !direct && (t.split_buyback_bps ?? 0) > 0;
  const splitter = direct && t.splitter ? (t.splitter as Address) : undefined;
  const locker = direct && t.locker ? (t.locker as Address) : undefined;
  const native = t.pair_token === zeroAddress;

  // What the router is holding for this launch, waiting for somebody to push it along.
  const { data: accruedRaw } = useReadContract({
    address: feeRouter ?? zeroAddress, abi: hoodFeeRouterAbi, functionName: "accrued", args: [t.token as Address],
    query: { enabled: Boolean(feeRouter) && !direct, refetchInterval: 12_000 },
  });
  // Undefined is not zero: a read that has not come back yet must not be reported as an empty
  // router, because a creator would read that as "my fee went somewhere else".
  const accrued = accruedRaw as bigint | undefined;

  // Where the creator leg is pointed right now. It is a registry row, not the launch row, because
  // it can be handed over and the indexer's `creator` never moves.
  const { data: recipientRaw } = useReadContract({
    address: factory ?? zeroAddress, abi: hoodFactoryAbi, functionName: "creatorFeeRecipient", args: [t.token as Address],
    query: { enabled: Boolean(factory) && keeps, refetchInterval: 30_000 },
  });
  const recipient = recipientRaw as Address | undefined;
  const paysMe = same(recipient, me);

  const { data: splitterData } = useReadContracts({
    contracts: [
      { address: splitter, abi: hoodRevenueSplitterAbi, functionName: "creator" },
      { address: splitter, abi: hoodRevenueSplitterAbi, functionName: "creatorClaimable" },
      { address: splitter, abi: hoodRevenueSplitterAbi, functionName: "accounted" },
    ] as never,
    query: { enabled: Boolean(splitter), refetchInterval: 12_000 },
  });
  const s = (splitterData ?? []) as { result?: unknown }[];
  const splitterCreator = s[0]?.result as Address | undefined;
  const claimable = s[1]?.result as bigint | undefined;
  const accounted = s[2]?.result as bigint | undefined;

  // Tax that has landed on the splitter and has not been split into the four roads yet. `sweep`
  // is what splits it, and `claim` sweeps first, so this is part of what a claim would pay out.
  const { data: nativeHeld } = useBalance({
    address: splitter, query: { enabled: Boolean(splitter) && native, refetchInterval: 12_000 },
  });
  const { data: erc20Held } = useReadContract({
    address: t.pair_token as Address, abi: erc20Abi, functionName: "balanceOf", args: [splitter ?? zeroAddress],
    query: { enabled: Boolean(splitter) && !native, refetchInterval: 12_000 },
  });
  const held = native ? nativeHeld?.value : (erc20Held as bigint | undefined);
  const unsplit = held === undefined || accounted === undefined ? undefined : held > accounted ? held - accounted : 0n;

  const mcap = (BigInt(t.price || "0") * BigInt(t.total_supply || "0")) / 10n ** 18n;
  /// A number the chain has not answered with yet is not a zero balance, and must not read as one.
  const amount = (value: bigint | undefined) => (value === undefined ? "reading" : `${fmt(value, dec, 6)} ${sym}`);

  /// The reason a button cannot be pressed, or nothing when it can. First reason wins, so the
  /// order is the order a creator would ask the questions in.
  const flushReason =
    !feeRouter ? "the fee router is not configured on this deployment"
    : accrued === undefined ? "still reading what the router is holding"
    : accrued === 0n ? "nothing is waiting in the router"
    : graduated && buysBack ? "a graduated buy back and burn buys on the open market, so its flush needs a price floor and goes through the keeper"
    : t.phase === 1 && buysBack ? "the curve is sold out: open the pool first"
    : undefined;

  const collectReason =
    direct
      ? (!locker ? "this launch has no locker on record" : undefined)
      : !graduator ? "the graduator is not configured on this deployment"
      : !graduated ? "there is no pool yet; it opens when the curve graduates"
      : undefined;

  const handoverReason =
    !factory ? "the factory is not configured on this deployment"
    : recipient === undefined ? "still reading who the fee stream pays"
    : !paysMe ? `the fee stream pays ${recipient ? shortAddress(recipient) : "another wallet"}, so only that wallet can hand it on`
    : !validAddress(handover) ? "type the wallet it should pay from now on"
    : same(handover, recipient) ? "that is the wallet it already pays"
    : undefined;

  const claimReason =
    !splitter ? "this launch has no splitter on record"
    : splitterCreator === undefined ? "still reading the splitter"
    : !same(splitterCreator, me) ? `the splitter pays ${shortAddress(splitterCreator)}, not this one`
    : claimable === undefined || unsplit === undefined ? "still reading what the splitter holds"
    : claimable === 0n && unsplit === 0n ? "nothing has come in since the last claim"
    : undefined;

  const sweepReason =
    !splitter ? "this launch has no splitter on record"
    : unsplit === undefined ? "still reading what the splitter holds"
    : unsplit === 0n ? "everything that arrived is already split"
    : undefined;

  return (
    <article className="panel creator-launch">
      <header className="creator-launch-head">
        <Artwork src={imageUrl(t.image)} symbol={t.symbol} size={52} rounded="rounded-xl" />
        <div className="creator-launch-name">
          <Link href={`/token/${t.token}`}>{t.name}</Link>
          <span className="mono dim">${t.symbol}</span>
        </div>
        <span className={`creator-badge ${graduated ? "creator-badge-on" : ""}`}>
          {graduated ? "graduated" : direct ? "in the pool" : "on the curve"}
        </span>
      </header>

      <div className="creator-facts">
        <Fact label={`${sym} market cap`} value={compact(mcap, dec)} />
        <Fact label={`${sym} 24h volume`} value={compact(BigInt(t.volume_24h || "0"), dec)} />
        <Fact label="trades" value={String(t.trades_total)} />
        <Fact label="where the fee goes" value={direct ? "split by the splitter" : splitLabel(t)} />
      </div>

      <div className="creator-progress">
        <div className="creator-progress-label">
          <span className="dim">{direct ? "the whole supply in the pool from block one" : "sold on a curve, then into a pool"}</span>
          <span className="mono">{graduated ? "graduated" : `${(progress * 100).toFixed(1)}% to the pool`}</span>
        </div>
        <div className="card-progress"><div style={{ width: `${graduated ? 100 : Math.min(100, progress * 100)}%` }} /></div>
      </div>

      {!direct && (
        <div className="creator-block">
          <div className="creator-block-title">The trading fee</div>
          <Row label="waiting in the router" value={amount(accrued)} />
          {keeps && (
            <Row label="paid to" value={<><Addr address={recipient} missing="reading" />{paysMe && <span className="text-[var(--color-lime)]"> · you</span>}</>} />
          )}
          <Action
            id="flush"
            label={keeps && paysMe ? "claim what is waiting to my wallet" : "push the fees through"}
            note={keeps
              ? `Anybody can send it. It lands at ${recipient ? shortAddress(recipient) : "the fee recipient"}, in one hop.`
              : `Anybody can send it. On this launch it goes to: ${splitLabel(t).toLowerCase()}.`}
            reason={flushReason}
            pending={pending}
            onClick={() => send("flush", () => writeContractAsync({
              address: feeRouter!, abi: hoodFeeRouterAbi, functionName: "flush", args: [t.token as Address],
            }))}
          />
        </div>
      )}

      <div className="creator-block">
        <div className="creator-block-title">The pool</div>
        <Action
          id="collect"
          label="collect the pool's fees"
          note={direct
            ? "Anybody can send it. What the locked position earned is burnt on the token side and split on the quote side."
            : "Anybody can send it. What the locked position earned comes back as fee for this token, then flushes along the same road as the rest."}
          reason={collectReason}
          pending={pending}
          onClick={() => send("collect", () => direct
            ? writeContractAsync({ address: locker!, abi: hoodLockerAbi, functionName: "harvestFees", args: [] })
            : writeContractAsync({ address: graduator!, abi: uniswapV4GraduatorAbi, functionName: "collect", args: [t.token as Address] }))}
        />
      </div>

      {direct && (
        <div className="creator-block">
          <div className="creator-block-title">Your share</div>
          <Row label="claimable now" value={amount(claimable)} />
          <Row label="arrived, not split yet" value={amount(unsplit)} />
          <Action
            id="claim"
            label="claim my share"
            note="Only you. It splits whatever arrived first, then pays your leg out to this wallet."
            reason={claimReason}
            pending={pending}
            onClick={() => send("claim", () => writeContractAsync({
              address: splitter!, abi: hoodRevenueSplitterAbi, functionName: "claim", args: [me],
            }))}
          />
          <Action
            id="sweep"
            label="split what arrived"
            note="Anybody can send it. It books the tax that has landed into the four roads without paying anything out."
            reason={sweepReason}
            pending={pending}
            onClick={() => send("sweep", () => writeContractAsync({
              address: splitter!, abi: hoodRevenueSplitterAbi, functionName: "sweep", args: [],
            }))}
          />
        </div>
      )}

      {keeps && (
        <div className="creator-block">
          <div className="creator-block-title">Hand the fee stream over</div>
          <p className="creator-note">
            One step, current recipient only, and it cannot be taken back. From the next trade on, the
            creator leg of the fee is theirs and not yours.
          </p>
          <AddressInput value={handover} onChange={setHandover} />
          <div className="creator-action">
            <ConfirmButton
              label={pending === "handover" ? "waiting for the block" : "hand it over"}
              confirm="press again to hand it over"
              className="btn btn-ghost"
              disabled={Boolean(handoverReason) || pending !== null}
              onConfirm={() => send("handover", () => writeContractAsync({
                address: factory!, abi: hoodFactoryAbi, functionName: "transferCreatorFeeRecipient",
                args: [t.token as Address, handover as Address],
              }))}
            />
            <p className="creator-note">{handoverReason ?? "Asks twice, then goes to your wallet to be signed."}</p>
          </div>
        </div>
      )}

      {!isCreator && (
        <p className="creator-note">
          The indexer has this launch printed by {shortAddress(t.creator)}, not by this wallet, so the
          creator-only buttons above stay switched off.
        </p>
      )}
      <WriteError error={error} />
    </article>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mono">{value}</div>
      <div className="dim">{label}</div>
    </div>
  );
}

/// One transaction: the button, and one line under it that is either what it does or why it
/// cannot be done. Never a button that is grey for a reason the page keeps to itself.
///
/// `id` is the label the writer holds while a transaction is in flight, so only the button that
/// was pressed says it is waiting; the rest of the card is switched off without changing its words.
function Action({ id, label, note, reason, pending, onClick }: {
  id: string; label: string; note: string; reason?: string; pending: string | null; onClick: () => void;
}) {
  return (
    <div className="creator-action">
      <button type="button" className="btn btn-ghost" disabled={Boolean(reason) || pending !== null} onClick={onClick}>
        {pending === id ? "waiting for the block" : label}
      </button>
      <p className={reason ? "creator-note creator-note-off" : "creator-note"}>{reason ?? note}</p>
    </div>
  );
}
