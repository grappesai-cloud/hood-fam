import type { Metadata } from "next";
import Link from "next/link";
import { brand } from "@/brands";
import "./doc.css";

/// The docs: what to click, what it costs, and what happens next. Task oriented, one page. The
/// reasons behind the rules are in the whitepaper. Static, server rendered, no client code.

export const metadata: Metadata = {
  title: `docs · ${brand.name}`,
  description: `How to use ${brand.name}: launch a token, trade, get paid as a holder, earn Payday as a trader, lock in the Vault.`,
  openGraph: {
    title: `docs · ${brand.name}`,
    description: `How to use ${brand.name}: launch a token, trade, get paid as a holder, earn Payday as a trader, lock in the Vault.`,
    type: "website",
  },
};

const SECTIONS = [
  ["start", "Getting started"],
  ["curve", "Launch on the curve"],
  ["direct", "Launch a direct pool"],
  ["trade", "How to trade"],
  ["holders", "How you get paid as a holder"],
  ["payday", "Payday for traders"],
  ["vault", "The Vault for lockers"],
  ["boosts", "Boosts"],
  ["referrals", "Referrals"],
  ["season", "The season drop"],
  ["bag", "The Bag page"],
  ["glossary", "Glossary"],
  ["faq", "FAQ"],
  ["api", "API and events"],
  ["addresses", "Contract addresses"],
] as const;

const PAGES: [string, string][] = [
  ["/discover", "The board: every launch, sorted and searchable."],
  ["/launch", "Create a token, on the curve or as a direct pool."],
  ["/token/[address]", "One token: chart, trades, holders, the creator's terms, buy and sell."],
  ["/trader/[address]", "One wallet: its trades, launches and points."],
  ["/portfolio", "Your tokens, positions, launches and what you are owed."],
  ["/bag", "The Bag: what came in, where it went, Payday and the burn clock, live."],
  ["/lock", "The Vault: lock the house coin, claim rewards."],
  ["/leaderboard", "Points and ranks for the season."],
  ["/ledger", "Receipts: every payout that reached you."],
  ["/airdrop", "The season drop: the pool, your share, the claim."],
  ["/quests", "Quests: fixed point rewards for set tasks."],
  ["/refer", "Your referral link and what it earned."],
  ["/bridge", "Bring money in from another chain, or send a launched token out."],
  ["/analytics", "Numbers for the whole site."],
  ["/terms", "The terms of use."],
  ["/privacy", "What the site collects."],
];

const ADDRESSES: [string, string][] = [
  ["Factory (HoodFactory)", "0x2b9c1f6667e05b68a5d1ab697710afc97a1949b5"],
  ["The Bag (HoodBag)", "0xf4ed44190cbf3ea597d6fa03855d402df42bd628"],
  ["Payday (HoodPayday)", "0x2ea48bbb382bfbe42088dfd1fcdaf4a0b8cff643"],
  ["Burn clock (HoodBurnClock)", "0x5603461f0b0264571d03a07fb32d70d95e4b9b96"],
  ["Boosts (HoodBoosts)", "0x8ed549aa479221ece612ce26d0f5b5d724114efb"],
  ["Graduation hook", "0x06f9fe8109867a22dd98d063ed43ea19b3d880cc"],
  ["Portal (direct launches)", "0xf3541ace9098775b812df2ff7acebaeecb5aef9e"],
  ["Opening auction (the sniper auction)", "0x7e1c0ab8ec48d529ecf44931684520062da7b930"],
  ["The Vault (HoodStaking)", "0xb24f6ee86438df7ac5d28fe04c7b77e04e2b4415"],
  ["Fee router (HoodFeeRouter)", "0x9208de8d02bf8b1d9a7c8c24668fc89320d4a677"],
  ["Referrals (HoodReferrals)", "0x64c006bb7f86a1d11f0b84b84b1d823bd6ce3f9a"],
  ["Graduator (UniswapV4Graduator)", "0x35e7982fd3511296a649598361f8707d63534b55"],
  ["Curve router (HoodCurveRouter)", "0x901d9591fae99e10e4754a86bc3006f835347619"],
  ["First-buy locker (HoodTokenLock)", "0x194a2bc75bdd337a92278e3b11279b2d25b11d35"],
  ["Bridge factory (HoodBridgeFactory)", "0x2b90021cf4ad2306c9f21f4ba4914cc55329634e"],
  ["Direct deployer (HoodDirectDeployer)", "0xc8cdd635bd6c524d57e12918bee0c754555f6523"],
  ["Launch token implementation (HoodLaunchToken)", "0x69e83e0bfae1967f6267f65d1f9dee61df2da7e5"],
  ["Buyback module (HoodBuybackModule)", "0x1f2db6dc21d9c643d8406da1d2c3d7ef125cb047"],
  ["Season drop (HoodSeasonDrop)", "0x44a085d3a3e79d132f7468cc7d53308c8cb715b0"],
];

const EXTERNAL: [string, string][] = [
  ["Uniswap v4 PoolManager", "0x8366a39CC670B4001A1121B8F6A443A643e40951"],
  ["Uniswap v4 PositionManager", "0x58daec3116aae6D93017bAAea7749052E8a04fA7"],
  ["USDG (6 decimals)", "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"],
];

const GLOSSARY: [string, string][] = [
  ["The Bag", "The contract that receives the protocol's share of every fee and splits it by four fixed rules. No owner, no withdrawal."],
  ["The house", "Our share. Paid out of the Bag by the rules; never a share of the creator's fees."],
  ["The house coin", "The platform's own token. Not launched yet. The only coin the Vault stakes and the only coin the burn clock burns."],
  ["The token's pot", "The contract that pays a token's holders in proportion to what they hold. A HoodPot on curve launches, the revenue splitter on direct launches."],
  ["Confetti", "The graduation bonus: a quarter of the graduation fee, paid into the token's pot the moment it graduates."],
  ["Payday", "The hourly payout to traders, split by points, with a slice for the pots of the ten newest launches."],
  ["The Vault", "The staking contract for the house coin. Lock tiers from flexible (1x) to 180 days (2.5x). Rewards arrive in the assets the fees were paid in."],
  ["The burn clock", "The contract that buys the house coin once an hour per asset and burns it."],
  ["The keeper", "Our off-chain service. It pushes pot payouts every 5 minutes, calls Payday and the burn every hour, and pays the gas."],
  ["The curve", "A bonding curve: a contract that sells a token at a price that rises as more is sold, then graduates into a pool when it sells out."],
  ["Direct pool", "A launch whose whole supply goes straight into a Uniswap v4 pool, with a hook that takes the fee and the creator's terms on every swap."],
  ["The hook", "The contract attached to a direct launch's pool. It applies the fee, the creator's tax and the penalties."],
  ["Graduation", "The moment a curve sells out and its raise plus the reserved 20% of supply become locked liquidity in a pool."],
  ["The graduator", "The contract that opens a graduated pool and keeps the position forever. It has no transfer and no decrease-liquidity function."],
  ["Preset", "A fixed set of curve parameters: start cap, graduation cap, share of the raise that goes to liquidity, fees."],
  ["Quote asset", "What a token is priced in and what fees are paid in: ETH or USDG."],
  ["bps", "Basis points. 100 bps is 1%. 10,000 bps is 100%."],
  ["Creator tax", "On a direct launch, an extra 1% to 10% per side chosen by the creator and split by his allocations."],
  ["Allocations", "How the creator's tax splits: creator, buyback, dividends to holders, liquidity. They add up to 100%."],
  ["Snipe tax", "A surcharge on buys in the first seconds after a direct launch. Decays quadratically to zero over up to 600 seconds."],
  ["Opening window", "The first blocks of a direct launch, when no wallet may hold or buy more than the creator's caps. Up to 1,200 blocks."],
  ["Jeet tax", "A charge of up to 25% on a sell made within the creator's window after the buy (at most 1 hour)."],
  ["Whale tax", "A charge of up to 25% on a sell that moves the price more than the creator's tick limit (at most 2,000 ticks)."],
  ["Penalties to vault", "A creator option that sends the holders' share of penalties to the Vault instead of the token's pot."],
  ["King of the hill", "On a direct launch, a pot fed by penalties that goes to the last crowned buyer 60 seconds after the last crown."],
  ["The sniper auction", "On a direct launch, an auction for the first slot after the creator's block. Half of the bid goes to the holders, half to liquidity."],
  ["The creator slash", "On a direct launch, when the creator sells into his pool, his unclaimed fees move to the holders."],
  ["First-buy lock", "A creator's own first buy held in HoodTokenLock for 7, 30, 90 or 180 days. It earns nothing."],
  ["Copycat lock", "For 48 hours after a launch that did 25 ETH (or 100,000 USDG) of volume in a day, its ticker and image cannot be reused."],
  ["Boost", "A paid slot on the board for one hour. 4 slots an hour, all proceeds to the house."],
  ["Points", "An off-chain score computed by the API from trades, launches, locks and referrals. It splits Payday and the season drop."],
  ["Rank", "A multiplier on your points, 1.5x to 5x, set by your 30-day volume."],
  ["Season drop", "A Merkle-based airdrop of a share of what the protocol earned in a season, claimable for at least 30 days."],
  ["Epoch", "One hour. Payday pays one epoch at a time."],
];

export default function Docs() {
  return (
    <div className="doc-page">
      <header className="doc-head">
        <p className="doc-kicker">Docs</p>
        <h1>Using {brand.name}</h1>
        <p className="doc-lead">
          What to click, what it costs, and what happens next. The reasons behind the rules are in
          the whitepaper. Every number here comes from the contracts.
        </p>
        <p className="doc-meta">
          Robinhood Chain, chain id 4663. Contracts deployed 25 September 2026. The whitepaper is at{" "}
          <Link href="/whitepaper">/whitepaper</Link>.
        </p>
      </header>

      <nav className="panel doc-toc" aria-label="Contents">
        <h2>Contents</h2>
        <ol>
          {SECTIONS.map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`}>{label}</a>
            </li>
          ))}
        </ol>
      </nav>

      <section className="panel" id="start">
        <h2>Getting started</h2>
        <p>
          You need a wallet on Robinhood Chain. There is no account and no sign-up. The site never
          holds your funds; every transaction is signed by your wallet.
        </p>
        <ol>
          <li>
            Add Robinhood Chain to your wallet. Chain id <code>4663</code>. RPC{" "}
            <code>https://rpc.mainnet.chain.robinhood.com</code>. Explorer{" "}
            <code>https://robinhoodchain.blockscout.com</code>. Gas is paid in ETH.
          </li>
          <li>
            Get ETH or USDG on the chain. <Link href="/bridge">/bridge</Link> brings money in from
            another chain and lands it in your own wallet. USDG is the dollar quote asset; it has 6
            decimals.
          </li>
          <li>Press Connect in the header and pick your wallet.</li>
          <li>Open <Link href="/discover">/discover</Link> and pick a token, or <Link href="/launch">/launch</Link> to make one.</li>
        </ol>
        <h3>The pages</h3>
        <div className="doc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Page</th>
                <th>What it is</th>
              </tr>
            </thead>
            <tbody>
              {PAGES.map(([path, what]) => (
                <tr key={path}>
                  <td><code>{path}</code></td>
                  <td>{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" id="curve">
        <h2>Launch on the curve</h2>
        <p>
          A curve launch sells 80% of the supply along a bonding curve, a price line that rises as
          more is sold. When it sells out, the token graduates into a locked Uniswap v4 pool. It is
          the shape to pick when you want price discovery before a pool exists.
        </p>
        <h3>Step by step</h3>
        <ol>
          <li>Open <Link href="/launch">/launch</Link> and choose the curve.</li>
          <li>Enter the name, ticker, image, description and links. This is what the board and the token page show.</li>
          <li>Pick a preset. The table below has the three.</li>
          <li>
            Choose your fee split. Your 30 bps of every trade go through the fee router, and you fix
            at launch how they split between four legs: stakers (paid to the Vault), buyback,
            liquidity and creator. A stakers leg is refused until the house coin exists.
          </li>
          <li>
            Optionally make a first buy in the launch transaction. For an ETH launch, any value you
            send above the launch fee is your first buy. For a USDG launch you set the amount. You can
            lock that first buy in the first-buy locker for 7, 30, 90 or 180 days. It earns nothing
            there, and it tells buyers you cannot sell it into them.
          </li>
          <li>Confirm. You pay the launch fee of 0.002 ETH plus your first buy. The fee goes to the house.</li>
        </ol>
        <p>
          The launch block belongs to you: only the creator can receive tokens in it. Trading opens
          the next block.
        </p>
        <h3>Presets</h3>
        <div className="doc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Preset</th>
                <th>Quote</th>
                <th className="num">Start cap</th>
                <th className="num">Graduation cap</th>
                <th className="num">Raise, about</th>
                <th className="num">To liquidity</th>
                <th className="num">Graduation fee</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>0</td><td>ETH</td><td className="num">1 ETH</td><td className="num">10 ETH</td><td className="num">4.4 ETH</td><td className="num">9,000 bps</td><td className="num">10% of the raise</td></tr>
              <tr><td>1</td><td>ETH</td><td className="num">2 ETH</td><td className="num">40 ETH</td><td className="num">16.8 ETH</td><td className="num">9,500 bps</td><td className="num">5% of the raise</td></tr>
              <tr><td>2</td><td>USDG</td><td className="num">5,000 USDG</td><td className="num">50,000 USDG</td><td className="num">22,000 USDG</td><td className="num">9,000 bps</td><td className="num">10% of the raise</td></tr>
            </tbody>
          </table>
        </div>
        <p>
          Every preset: supply 1,000,000,000; 80% on the curve; 20% reserved to seed the pool; trade
          fee 1%, of which 70 bps to the Bag and 30 bps to the creator. The factory requires at
          least 8,000 bps of the raise to go to liquidity. The start cap is the market cap at the
          first token sold; the graduation cap is the market cap when the curve sells out.
        </p>
        <h3>The copycat lock</h3>
        <p>
          A ticker (case does not matter) or an image already used by a launch that did 25 ETH, or
          100,000 USDG, of volume in 24 hours is locked for 48 hours. The lock refreshes every hour
          while the volume holds. A launch that hits it reverts.
        </p>
        <h3>What happens next</h3>
        <ol>
          <li>Buyers pay the curve, sellers sell back to it. Every trade pays 1%. No penalties apply on the curve.</li>
          <li>When the curve sells out it stops trading. Anyone, usually the keeper, calls <code>finalize()</code>.</li>
          <li>
            The token graduates. The raise, less the graduation fee, and the reserved 20% go into a
            full-range Uniswap v4 pool, priced at the ratio the raise came out at. The position stays
            in the graduator forever.
          </li>
          <li>The graduation fee goes to the Bag: half to the house, a quarter to the Vault, a quarter as Confetti to the token&apos;s pot.</li>
          <li>
            From now on the pool charges 1% plus its own 0.3% fee. Anyone can call <code>collect</code>:
            the token side is burned and the quote side goes to your fee split. Any jeet or whale
            tax you set at launch applies from here.
          </li>
        </ol>
      </section>

      <section className="panel" id="direct">
        <h2>Launch a direct pool</h2>
        <p>
          A direct launch puts the whole supply into a Uniswap v4 pool in the launch transaction.
          The token trades from the first block. A hook on the pool takes the 1% fee, your own tax
          and any penalties you switch on. Every setting below is fixed at launch and cannot change.
        </p>
        <h3>Step by step</h3>
        <ol>
          <li>Open <Link href="/launch">/launch</Link> and choose the direct pool.</li>
          <li>Enter the name, ticker, image and description. Pick the quote asset: ETH or USDG.</li>
          <li>
            Set your tax, 1% to 10% per side (100 to 1,000 bps). Buyers and sellers pay it on top of
            the 1%. Set the allocations for it: creator, buyback, dividends to holders, liquidity.
            They must add up to 100%.
          </li>
          <li>
            Set the snipe tax. It starts at the rate you pick and decays quadratically to zero over
            up to 600 seconds. The app&apos;s default is 50% over 3 seconds. Your tax plus the snipe tax
            can never exceed 99%.
          </li>
          <li>
            Set the opening window. For a number of blocks, up to 1,200 (about 2 minutes at 100 ms
            blocks), no wallet may hold more than your hold cap or buy more than your buy cap. The
            buy cap is at most 1.1x the hold cap. The default is 30 blocks. Selling is never capped.
          </li>
          <li>
            Set the penalties: a jeet tax of up to 25% on sells within a window of up to 1 hour after
            the buy, and a whale tax of up to 25% on a sell that moves the price more than your tick
            limit, up to 2,000 ticks. Choose whether the holders&apos; share of penalties goes to the
            token&apos;s pot or to the Vault.
          </li>
          <li>
            Optionally switch on king of the hill: up to 50% of the holders&apos; share of every penalty
            feeds a pot that the last crowned buyer wins 60 seconds after the last crown.
          </li>
          <li>
            Optionally open a sniper auction for the first slot after your launch block: a window
            of up to 300 blocks in which nobody can buy and bids are taken instead.
          </li>
          <li>Optionally set an initial buy. It goes straight through the PoolManager in the launch transaction.</li>
          <li>Confirm. You pay the launch fee of 0.002 ETH plus your initial buy. The launch block is yours alone.</li>
        </ol>
        <h3>Where your tax goes</h3>
        <p>
          The 1% platform fee splits 30 bps to you and 70 bps to the Bag on every trade. Your own
          tax lands in the token&apos;s revenue splitter and is split by your allocations. Your creator
          leg waits for you to claim it on the token page or in your portfolio. The dividends leg
          pays holders through the pot. The buyback leg is spent by a shared module that buys the
          token and burns it. The liquidity leg is pushed into the locked position.
        </p>
        <p className="doc-note">
          If you, or the wallet that receives your fees, sell into your own pool, every creator fee
          you have not claimed moves to the holders in the same transaction. That is the creator
          slash. Claim first, and do not sell into your own pool if you want to keep your fees.
        </p>
        <h3>The sniper auction, in practice</h3>
        <ul>
          <li>Bids are in your quote asset. For ETH the minimum bid is the launch fee. Each bid must beat the last by 5%.</li>
          <li>A bidder who is outbid gets the money back at once. If the refund cannot be delivered, it is booked and taken with <code>claimRefund</code>.</li>
          <li>After the window, the winner alone can receive tokens from the pool for 20 blocks.</li>
          <li>Anyone can settle after the window. Half of the winning bid goes to your token&apos;s pot for the holders, half to the locker as liquidity.</li>
          <li>No bids: the pool opens after the window, as if there had been no auction.</li>
        </ul>
      </section>

      <section className="panel" id="trade">
        <h2>How to trade</h2>
        <p>
          Open a token from the board. The token page shows the chart, the tape, the holders and
          the creator&apos;s terms. Buy and sell live on the same page. Every transaction is built by
          the site and signed by your wallet.
        </p>
        <h3>What a trade costs</h3>
        <ul>
          <li>1% of the trade, always. 30 bps go to the creator, 70 bps to the Bag.</li>
          <li>On a direct launch, the creator&apos;s tax on top: 1% to 10% per side, shown on the token page.</li>
          <li>On a graduated pool, the pool&apos;s own 0.3% fee on top.</li>
          <li>
            Penalties, when they apply and the creator set them: the snipe tax in the first seconds
            after a direct launch, the jeet tax on a sell soon after your buy, the whale tax on a sell
            that moves the price too far. Each is at most 25%, except the snipe tax, which starts
            where the creator set it and falls to zero.
          </li>
        </ul>
        <p>
          Read the terms box on the token page before you buy. On a curve launch nothing but the 1%
          applies until graduation.
        </p>
        <h3>What you see on the tape</h3>
        <p>
          The tape lists every trade on the token: buy or sell, the wallet, the size in the quote
          asset, the tokens moved, the price and the time. Fees and penalties are taken inside the
          transaction, so the amount you paid is more than the pool received on a buy, and the
          amount you received is less than the pool paid on a sell. The Bag page has a second tape
          that lists every fee and penalty and where it went.
        </p>
        <h3>Things that can make a trade revert</h3>
        <ul>
          <li>Buying in the launch block: it belongs to the creator.</li>
          <li>Buying during a sniper auction window, or in the 20 blocks after it if you are not the winner.</li>
          <li>Buying over the hold cap or the buy cap during the opening window. The hold cap applies to plain transfers too.</li>
          <li>Selling with an exact output amount on a graduated pool that has penalties. Sell with an exact input instead.</li>
          <li>The first sell of a token on a pool may need extra approvals before the swap. The site asks for them one at a time.</li>
        </ul>
      </section>

      <section className="panel" id="holders">
        <h2>How you get paid as a holder</h2>
        <p>
          Every token has a pot. The pot pays the token&apos;s holders in proportion to what they hold.
          You do nothing to earn from it: holding is enough. Your claim grows as money arrives, and
          the token updates the pot on every balance move.
        </p>
        <h3>What fills the pot</h3>
        <ul>
          <li>Confetti, the graduation bonus: a quarter of the graduation fee, paid the moment a curve token graduates. Whoever holds the token at that moment gets a share.</li>
          <li>80% of every penalty paid on the token, unless the creator sent penalties to the Vault. With king of the hill on, part of that goes to the king pot instead.</li>
          <li>On a direct launch, the dividends leg of the creator&apos;s tax.</li>
          <li>On a direct launch with a sniper auction, half of the winning bid.</li>
          <li>Payday&apos;s slice for the ten newest launches: up to 10% of every hour&apos;s Payday.</li>
          <li>On a direct launch, the creator slash: the creator&apos;s unclaimed fees when the creator sells.</li>
        </ul>
        <h3>The 5-minute push</h3>
        <p>
          The keeper calls <code>pushMany</code> on every pot every 5 minutes. It pays every holder
          whose claim is above 0.0001 ETH (1e14 wei), straight to the wallet, and the keeper pays
          the gas. If your claim is below the floor it stays in the pot until it grows past it, or
          until you claim it yourself. Payouts land in <Link href="/ledger">/ledger</Link> and under
          &quot;Paid to you&quot; in <Link href="/portfolio">/portfolio</Link>.
        </p>
        <h3>Claiming yourself</h3>
        <p>
          <code>claim(account)</code> is open to anyone, and it always pays the holder. The claim
          button on the token page and in your portfolio is the fallback for what is booked and not
          yet pushed. You pay the gas for that one.
        </p>
        <p className="doc-small">
          Contracts never earn: the curve, the graduator, the pot, the first-buy locker, the
          staking contract, the PoolManager and the hook are excluded from the share.
        </p>
      </section>

      <section className="panel" id="payday">
        <h2>Payday for traders</h2>
        <p>
          Payday pays traders every hour from 10 bps of every trade and 5% of every penalty. The
          hour&apos;s money is split by points. You do not claim it: the keeper sends it to your wallet.
        </p>
        <h3>The hourly payout</h3>
        <ul>
          <li>An epoch is one hour. After it closes, the keeper (or the factory owner) calls <code>pay</code> for it, once per hour per asset.</li>
          <li>One payout covers at most 500 wallets and 10 pots.</li>
          <li>Up to 10% of the hour goes to the pots of the ten most recent launches. The holders of those tokens get it.</li>
          <li>The rest goes to wallets in proportion to their points for that hour.</li>
          <li>Anything not paid carries into the next hour. Claims under 1e13 wei are not paid.</li>
        </ul>
        <h3>Points</h3>
        <p>
          Points are computed off the chain by the API. They are not a token. They decide how an
          hour&apos;s Payday, and the season drop, split. Trading against your own launch does not
          score.
        </p>
        <div className="doc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>What you do</th>
                <th>Points</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Launch a token</td><td>500, credited only after the token has done 1,000 USD of volume</td></tr>
              <tr><td>Buy</td><td>2 per dollar</td></tr>
              <tr><td>Sell</td><td>1 per dollar</td></tr>
              <tr><td>Lock the house coin</td><td>10 per dollar per 30 days locked, times the lock multiplier (1x to 2.5x)</td></tr>
              <tr><td>Bounty</td><td>1, for holding a token at the moment a bot paid a penalty on it</td></tr>
              <tr><td>Rank</td><td>multiplies the rows above by 1.5x to 5x, set by your 30-day volume</td></tr>
              <tr><td>Referral</td><td>10% of the trading points of a wallet you referred, on top of theirs, not multiplied</td></tr>
              <tr><td>Quest</td><td>the amount on the card, not multiplied</td></tr>
            </tbody>
          </table>
        </div>
        <div className="doc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th className="num">30-day volume from (USD)</th>
                <th className="num">Multiplier</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Wood</td><td className="num">0</td><td className="num">1.5x</td></tr>
              <tr><td>Bronze</td><td className="num">10,000</td><td className="num">2x</td></tr>
              <tr><td>Silver</td><td className="num">50,000</td><td className="num">2.5x</td></tr>
              <tr><td>Gold</td><td className="num">150,000</td><td className="num">3x</td></tr>
              <tr><td>Platinum</td><td className="num">500,000</td><td className="num">4x</td></tr>
              <tr><td>Degen</td><td className="num">1,000,000</td><td className="num">5x</td></tr>
            </tbody>
          </table>
        </div>
        <p>
          Rank is re-earned from rolling 30-day volume, not kept. <Link href="/leaderboard">/leaderboard</Link>{" "}
          shows the season&apos;s points and ranks.
        </p>
      </section>

      <section className="panel" id="vault">
        <h2>The Vault for lockers</h2>
        <p className="doc-note">
          The house coin has not launched yet. Until the factory owner sets it in the Vault, nothing
          can be locked and the Vault pays nothing. Its share of every fee waits in the Bag and can
          be released to the Vault once the coin exists.
        </p>
        <p>
          The Vault pays people who lock the house coin. It is on <Link href="/lock">/lock</Link>.
          Rewards come in the assets the fees were paid in: ETH, USDG, up to 8 assets in total. A
          position is owed a list of assets, not one number.
        </p>
        <h3>Tiers</h3>
        <div className="doc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Lock</th>
                <th className="num">Multiplier</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Flexible</td><td className="num">1x</td></tr>
              <tr><td>7 days</td><td className="num">1.25x</td></tr>
              <tr><td>30 days</td><td className="num">1.5x</td></tr>
              <tr><td>90 days</td><td className="num">2x</td></tr>
              <tr><td>180 days</td><td className="num">2.5x</td></tr>
            </tbody>
          </table>
        </div>
        <p>
          A lock longer than 365 days reverts. A lock between tiers gets the multiplier of the tier
          it reached. The multiplier is your weight when rewards are shared.
        </p>
        <h3>What pays in</h3>
        <ul>
          <li>30 bps of every trade on the site, through the Bag.</li>
          <li>A quarter of every graduation fee.</li>
          <li>Half of the house coin&apos;s own trade leg.</li>
          <li>The stakers leg of curve launches whose creator chose one.</li>
          <li>Penalties on tokens whose creator chose &quot;penalties to vault&quot;.</li>
          <li>Confetti from a graduated launch with no pot.</li>
        </ul>
        <h3>Claim, unstake, demote</h3>
        <ul>
          <li><code>claim(id)</code> is open to anyone and always pays the position&apos;s owner, every asset at once. The keeper can push it for you.</li>
          <li>You can unstake only after your unlock time.</li>
          <li><code>demote(id)</code> is open to anyone after unlock and resets a position to 1x. An expired lock does not keep its weight.</li>
          <li>Rewards that arrive while nothing is staked go to the first staker.</li>
        </ul>
        <p className="doc-small">
          A creator&apos;s locked first buy is not in the Vault. It sits in the first-buy locker, earns
          nothing, and unlocks after 7, 30, 90 or 180 days.
        </p>
      </section>

      <section className="panel" id="boosts">
        <h2>Boosts</h2>
        <p>
          A boost puts a token in a paid slot on the board for one hour. There are 4 slots per hour.
          The price is 0.005 ETH by default; the factory owner can set it up to 0.05 ETH. You can buy
          a slot for the current hour or the next one. A token can hold one slot per hour. Every
          boost payment goes to the house.
        </p>
      </section>

      <section className="panel" id="referrals">
        <h2>Referrals</h2>
        <p>
          <Link href="/refer">/refer</Link> gives you a link. A wallet that arrives through it is tied
          to you once it connects. From then on you earn 10% of that wallet&apos;s trading points, on
          top of theirs, for trades made after the two of you were tied. Referral points are not
          multiplied by rank.
        </p>
        <p>
          Separately, the owner can set an on-chain referral cut for a token: a referrer address
          and a share of at most 5,000 bps of the Bag&apos;s share of that token&apos;s fees. It comes only
          from the protocol&apos;s side, never from the creator or the holders.
        </p>
      </section>

      <section className="panel" id="season">
        <h2>The season drop</h2>
        <p>
          At the end of a season, a share of what the protocol earned is dropped to every wallet
          that earned points, in proportion to points. Off the chain the pool is 30% of the
          season&apos;s protocol take. <Link href="/airdrop">/airdrop</Link> shows the pool and your
          share.
        </p>
        <ol>
          <li>The season closes and the leaderboard is frozen.</li>
          <li>A Merkle tree is built with every wallet&apos;s amount.</li>
          <li>The owner opens the season on the chain and funds it in the same transaction.</li>
          <li>Claims are open for at least 30 days. Anyone can claim for anyone; the money always goes to the listed wallet.</li>
          <li>After the deadline the owner can sweep what was not claimed back to the treasury. There is no rescue function before that.</li>
        </ol>
        <p>No token is promised. The drop pays in the assets the protocol earned.</p>
      </section>

      <section className="panel" id="bag">
        <h2>The Bag page</h2>
        <p>
          <Link href="/bag">/bag</Link> shows what came into the Bag, per asset, and where it went:
          the house, the Vault, Payday, the burn clock and Confetti. It shows the shares held for the
          Vault and the burn while the house coin does not exist. It shows the Payday clock for the
          current hour, the burn clock, the boost slots, the contract addresses and the wall of
          shame: the wallets that paid penalties.
        </p>
        <p>
          &quot;Shown live&quot; means this: every number is read from the Bag&apos;s own events on the
          chain by our indexer, and the page refetches the moment a new receipt lands. Nothing on it
          is typed in by hand. A figure the indexer cannot compute honestly, such as a dollar value
          for an asset with no price, is shown as a dash with the reason, never as a zero. The chain
          is authoritative if the page and the chain ever disagree.
        </p>
      </section>

      <section className="panel" id="glossary">
        <h2>Glossary</h2>
        <dl>
          {GLOSSARY.map(([term, meaning]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{meaning}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="panel" id="faq">
        <h2>FAQ</h2>
        <h3>Do I need an account?</h3>
        <p>No. You need a wallet on Robinhood Chain with some ETH for gas. The site never holds your funds.</p>
        <h3>What does a trade cost?</h3>
        <p>
          1% of the trade, always: 30 bps to the creator and 70 bps to the Bag. On a direct launch the
          creator&apos;s tax of 1% to 10% per side comes on top. On a graduated pool the pool&apos;s own
          0.3% comes on top. Penalties apply only in the cases the creator set.
        </p>
        <h3>When do I get paid as a holder?</h3>
        <p>
          Every 5 minutes, if your claim is above 0.0001 ETH. The keeper pushes it to your wallet and
          pays the gas. Below the floor, it waits or you claim it yourself.
        </p>
        <h3>Why did my buy revert?</h3>
        <p>
          The launch block belongs to the creator. A sniper auction window blocks buys, and only the
          winner can buy for 20 blocks after it. During the opening window a buy that takes you over
          the hold cap or the buy cap reverts. The copycat lock reverts a launch, not a buy.
        </p>
        <h3>Why was I charged more than 1%?</h3>
        <p>
          A direct launch has the creator&apos;s tax. A graduated pool has the 0.3% pool fee. A buy in
          the first seconds after a direct launch pays the snipe tax. A sell soon after a buy can pay
          the jeet tax. A sell that moves the price past the creator&apos;s tick limit can pay the
          whale tax. The token page lists every one the creator set.
        </p>
        <h3>Can the creator change the fees after launch?</h3>
        <p>No. Fees, taxes, allocations, penalties and options are fixed at launch. Nobody can change them, including us.</p>
        <h3>Can anyone take money out of the Bag?</h3>
        <p>
          No. The Bag has no owner and no withdrawal function. It only pays its four outlets by fixed
          rules. The house is paid by those rules like everyone else.
        </p>
        <h3>Where is the house coin?</h3>
        <p>
          It has not launched. The Vault and the burn clock wait for it. Their shares of every fee are
          held in the Bag and can be released once the coin exists. Nothing here promises it a date
          or a price.
        </p>
        <h3>Are points a token?</h3>
        <p>
          No. Points are a score computed off the chain by the API. They decide how Payday and the
          season drop split between wallets. They are not a balance owed to you.
        </p>
        <h3>What happens if the keeper stops?</h3>
        <p>
          Holders can claim from their pots themselves, and anyone can push for them. Curves can be
          finalized by anyone. Payday and the burn wait for the keeper or the factory owner; the money
          stays in place until then. Nothing moves to the wrong place.
        </p>
      </section>

      <section className="panel" id="api">
        <h2>API and events</h2>
        <p>
          The app reads from our indexer, an API that follows the chain and can be rebuilt from it.
          Nothing in it is authoritative over the contracts. Amounts are strings in the asset&apos;s
          smallest unit; <code>price</code> is quote wei per whole token. The full integration guide,
          with event signatures, topic hashes and custom errors, is <code>docs/INTEGRATION.md</code>{" "}
          in the repository. It predates the Bag, so the events of the Bag, Payday, the pots and the
          burn clock are not in it yet.
        </p>
        <h3>REST routes</h3>
        <div className="doc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Route</th>
                <th>What it returns</th>
              </tr>
            </thead>
            <tbody>
              <tr><td><code>GET /health</code></td><td>Whether the indexer is up and the last block it indexed.</td></tr>
              <tr><td><code>GET /tokens</code></td><td>The board. Query: <code>sort</code> (new, volume, progress, graduated), <code>status</code> (curve, sold_out, graduated, graduating), <code>creator</code>, <code>q</code>, <code>limit</code>, <code>offset</code>.</td></tr>
              <tr><td><code>GET /tokens/:token</code></td><td>One token, plus holders count, fee flows and staking.</td></tr>
              <tr><td><code>GET /tokens/:token/trades</code></td><td>The tape. <code>limit</code> up to 50.</td></tr>
              <tr><td><code>GET /tokens/:token/candles</code></td><td>OHLC candles. <code>interval</code>: 1 minute, 5 minutes, 15 minutes, 1 hour, 4 hours, 1 day.</td></tr>
              <tr><td><code>GET /tokens/:token/holders</code></td><td>The top 100 holders by balance.</td></tr>
              <tr><td><code>GET /stats</code></td><td>Launches, graduations, volume, trades and traders for the whole site.</td></tr>
              <tr><td><code>GET /portfolio/:address</code></td><td>A wallet&apos;s tokens, positions and launches.</td></tr>
              <tr><td><code>GET /stakes/:owner</code></td><td>A wallet&apos;s Vault positions.</td></tr>
              <tr><td><code>GET /points/:address</code></td><td>A wallet&apos;s points.</td></tr>
              <tr><td><code>GET /leaderboard</code></td><td>The season&apos;s ranking. Query: <code>season</code>, <code>limit</code>.</td></tr>
              <tr><td><code>GET /seasons</code></td><td>The seasons.</td></tr>
              <tr><td><code>GET /pairs</code></td><td>The quote assets a launch may be priced in, with decimals, dollar price and the copycat lock threshold.</td></tr>
              <tr><td><code>GET /stream</code></td><td>Server-sent events: <code>trade</code>, <code>launch</code>, <code>graduated</code>, <code>message</code>, <code>ping</code>. Optional <code>tokens</code> filter, up to 100 addresses.</td></tr>
              <tr><td><code>POST /chat/nonce</code>, <code>POST /chat/session</code></td><td>Sign in to a token&apos;s chat with a wallet signature. A session lasts seven days.</td></tr>
              <tr><td><code>GET /chat/:token</code>, <code>POST /chat/:token</code>, <code>POST /chat/:token/hide/:id</code></td><td>Read a token&apos;s room, post in it (holders and past traders only), hide a message (the creator or an operator).</td></tr>
            </tbody>
          </table>
        </div>
        <h3>Events the guide documents</h3>
        <div className="doc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Contract</th>
                <th>Events</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Factory</td><td><code>Launched</code>, <code>LaunchMetadata</code>, <code>FirstBuyLocked</code></td></tr>
              <tr><td>Curve (one per launch)</td><td><code>Bought</code>, <code>Sold</code>, <code>SoldOut</code>, <code>Graduated</code></td></tr>
              <tr><td>Fee router</td><td><code>Accrued</code>, <code>Flushed</code></td></tr>
              <tr><td>Portal</td><td><code>DirectLaunched</code>, <code>DirectMetadata</code>, <code>PoolOpened</code></td></tr>
              <tr><td>Launch hook (one per direct launch)</td><td><code>Taxed</code>, <code>Bonded</code>, <code>ClaimsFlushed</code></td></tr>
              <tr><td>Revenue splitter (one per direct launch)</td><td><code>Swept</code>, <code>DividendsClaimed</code>, <code>CreatorClaimed</code>, <code>ProtocolClaimed</code>, <code>BuybackReleased</code>, <code>LiquidityPushed</code></td></tr>
              <tr><td>Buyback module</td><td><code>BoughtBack</code></td></tr>
              <tr><td>Locker (one per direct launch)</td><td><code>FeesHarvested</code>, <code>LiquidityDeepened</code></td></tr>
              <tr><td>Uniswap v4 PoolManager</td><td><code>Swap</code>, keyed by pool id</td></tr>
              <tr><td>Every token</td><td>ERC-20 <code>Transfer</code>; a transfer to the zero address is a burn</td></tr>
            </tbody>
          </table>
        </div>
        <p className="doc-small">
          Public RPC notes from the guide: <code>eth_getLogs</code> ranges above a few thousand
          blocks are refused, one request in flight at a time is the shape that works, there is no
          JSON-RPC batching, and historical state is pruned after about thirty minutes.
        </p>
      </section>

      <section className="panel doc-addresses" id="addresses">
        <h2>Contract addresses</h2>
        <p>
          Robinhood Chain, chain id 4663. Deployed on 25 September 2026; the first receipt is in
          block 72198515.
        </p>
        <div className="doc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Contract</th>
                <th>Address</th>
              </tr>
            </thead>
            <tbody>
              {ADDRESSES.map(([name, address]) => (
                <tr key={address}>
                  <td>{name}</td>
                  <td><code>{address}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3>External</h3>
        <div className="doc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Contract</th>
                <th>Address</th>
              </tr>
            </thead>
            <tbody>
              {EXTERNAL.map(([name, address]) => (
                <tr key={address}>
                  <td>{name}</td>
                  <td><code>{address}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="doc-small">
          Pending: the house coin is not set. The Safe has not accepted ownership; the deployer
          wallet still owns the factory, the portal, the referrals registry and the bridge factory.
        </p>
      </section>

      <p className="doc-foot">
        The reasons behind these rules, and the exact split tables, are in the{" "}
        <Link href="/whitepaper">whitepaper</Link>. The terms are at <Link href="/terms">/terms</Link>.
      </p>
    </div>
  );
}
