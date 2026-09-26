import type { Metadata } from "next";
import Link from "next/link";
import { brand } from "@/brands";
import "../docs/doc.css";

/// The whitepaper: the whole design in plain words, with every number taken from the contracts.
/// Static, server rendered, no client code. The practical guide is /docs.

export const metadata: Metadata = {
  title: `whitepaper · ${brand.name}`,
  description: `How ${brand.name} works: the two ways to launch, what a trade costs, and where every part of the fee goes.`,
  openGraph: {
    title: `whitepaper · ${brand.name}`,
    description: `How ${brand.name} works: the two ways to launch, what a trade costs, and where every part of the fee goes.`,
    type: "website",
  },
};

const SECTIONS = [
  ["what", "What bags.fam is"],
  ["launch", "Two ways to launch"],
  ["cost", "What a trade costs"],
  ["bag", "The Bag"],
  ["pot", "The token's pot"],
  ["payday", "Payday"],
  ["vault", "The Vault"],
  ["burn", "The burn clock"],
  ["graduation", "Graduation and Confetti"],
  ["penalties", "Penalties and the creator's options"],
  ["king", "King of the hill"],
  ["auction", "The sniper auction"],
  ["slash", "The creator slash"],
  ["boosts", "Boosts and the launch fee"],
  ["referrals", "Referrals"],
  ["season", "The season drop"],
  ["keeper", "On the chain and off the chain"],
  ["guarantees", "What is guaranteed and what is not"],
  ["risks", "Risks"],
  ["addresses", "Contract addresses"],
] as const;

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

export default function Whitepaper() {
  return (
    <div className="doc-page">
      <header className="doc-head">
        <p className="doc-kicker">Whitepaper</p>
        <h1>How {brand.name} works</h1>
        <p className="doc-lead">
          {brand.name} is a token launchpad on Robinhood Chain. This paper explains the two ways to
          launch, what a trade costs, and where every part of the fee goes. Every number here is a
          number the contracts apply.
        </p>
        <p className="doc-meta">
          Version 3. Contracts deployed on Robinhood Chain (chain id 4663) on 25 September 2026.
          The practical guide is at <Link href="/docs">/docs</Link>.
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

      <section className="panel" id="what">
        <h2>What {brand.name} is</h2>
        <p>
          {brand.name} is a place to launch a token and trade it. A launch is one transaction. The
          token trades from the first block. Every trade pays a fee of 1%. The contracts split that
          fee by rules that are written in code and fixed at launch. Nobody can change the rules of
          a live token afterwards. Not the creator, and not us.
        </p>
        <p>
          Most of that fee goes back to the people who use the site. The holders of each token are
          paid from the token&apos;s pot. Traders are paid every hour by Payday. People who lock the
          house coin are paid by the Vault. The burn clock buys the house coin and burns it. Our own
          share is called the house. Each of these has a section below.
        </p>
        <p>
          This paper says who pays, who gets paid, and when. It also says what runs on the chain and
          what our off-chain service, the keeper, does. The keeper mostly calls functions that are
          open to anyone. Two hourly payouts, Payday and the burn, are limited to the keeper and to
          the factory owner. If the keeper stops, money does not go to the wrong place. It waits.
        </p>
        <p>
          Two things are not live yet. The house coin has not been launched, so the Vault and the
          burn clock wait for it. The Safe has not accepted ownership of the factory yet. Both are
          stated again in <a href="#guarantees">what is guaranteed and what is not</a>.
        </p>
      </section>

      <section className="panel" id="launch">
        <h2>Two ways to launch</h2>
        <p>A creator picks one of two shapes. They are different markets, not different tiers.</p>
        <h3>The curve</h3>
        <p>
          The factory creates a token with a fixed supply and opens a bonding curve for it. A
          bonding curve is a contract that sells tokens at a price that rises as more are sold, and
          buys them back along the same line. 80% of the supply is for sale on the curve. The other
          20% is set aside to seed a pool. When the curve sells out, it stops trading. Anyone can
          then call <code>finalize()</code>. The token graduates: the money the curve raised and the
          20% of supply go into a Uniswap v4 pool, and that liquidity is locked forever.
        </p>
        <h3>The direct pool</h3>
        <p>
          The portal creates the token and puts the whole supply into a Uniswap v4 pool in the
          launch transaction. There is no curve and no raise. A hook, a contract attached to the
          pool, takes the fee and the creator&apos;s optional tax on every swap. The creator can also
          switch on penalties, a sniper auction and king of the hill. Each is explained below.
        </p>
        <p>
          Both shapes print a token with a fixed supply, no owner and no mint function. Both fix the
          creator&apos;s terms at launch. They differ in where the price comes from. On the curve it
          comes from a formula until graduation. In a direct pool it comes from the pool from block
          one.
        </p>
      </section>

      <section className="panel" id="cost">
        <h2>What a trade costs</h2>
        <p>
          Every trade pays 1% of its size, which is 100 basis points (bps). The trader pays it, in
          the asset the token is priced in: ETH or USDG. The fee splits in two. 30 bps go to the
          creator. 70 bps go to the Bag. The Bag is the contract that receives the protocol&apos;s
          share of every fee and splits it by fixed rules. It has its own section.
        </p>
        <ul>
          <li>
            On a curve launch the two numbers come from the preset. Every preset today sends 70 bps
            to the Bag and 30 bps to the creator. The factory refuses a preset where the two add up
            to more than 500 bps.
          </li>
          <li>
            On a direct launch, and on every graduated pool, the two numbers are hardcoded: 30 bps
            to the creator, 70 bps to the Bag.
          </li>
          <li>
            A graduated pool is a Uniswap v4 pool, and the pool charges its own fee of 0.3% on top
            (poolFee 3000, tickSpacing 60). That fee accrues to the locked liquidity position.
            Anyone can call <code>collect</code> on the graduator. The token side is burned. The
            quote side goes to the creator&apos;s fee split.
          </li>
          <li>
            On a direct launch the creator can add a tax of his own, from 1% to 10% per side (100 to
            1,000 bps). The trader pays it on top of the 1%. The creator fixed at launch how it
            splits between four legs: the creator, a buyback, dividends to holders, and liquidity.
            The four legs add up to 100%. The tax and the snipe surcharge together can never take
            more than 99% (9,900 bps).
          </li>
          <li>
            Penalties can apply on top of all of this, in the cases listed in the{" "}
            <a href="#penalties">penalties section</a>.
          </li>
        </ul>
        <div className="doc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Parameter</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Trade fee, every machine</td><td>100 bps (1%)</td></tr>
              <tr><td>Creator&apos;s share of the trade fee</td><td>30 bps</td></tr>
              <tr><td>The Bag&apos;s share of the trade fee</td><td>70 bps</td></tr>
              <tr><td>Cap on Bag plus creator, curve presets</td><td>500 bps together</td></tr>
              <tr><td>Graduated pool LP fee, on top</td><td>0.3% (poolFee 3000, tickSpacing 60)</td></tr>
              <tr><td>Creator tax, direct launches</td><td>100 to 1,000 bps per side (1% to 10%)</td></tr>
              <tr><td>Creator tax plus snipe surcharge</td><td>at most 9,900 bps</td></tr>
              <tr><td>Referral cut</td><td>at most 5,000 bps of the Bag&apos;s share, never the creator&apos;s</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" id="bag">
        <h2>The Bag</h2>
        <p>
          The Bag (<code>HoodBag</code>) receives the protocol&apos;s share of every fee and splits it.
          Who gets paid depends on where the money came from. There are four rules, and they are
          constants in a library: nobody can edit them. The Bag has no owner and no withdrawal
          function. The addresses it pays, the house, the Vault, Payday and the burn clock, are set
          when it is deployed and cannot change.
        </p>
        <h3>Rule 1: trade fees</h3>
        <p>
          The 70 bps the Bag receives from a trade split four ways: 4,286 bps to the Vault, 1,429 to
          Payday, 1,429 to the burn clock, and the rest, 2,856, to the house. Measured against the
          whole 1% a trade pays, that is 30 bps to the Vault, 10 to Payday, 10 to the burn, and 20 to
          the house. With the 30 bps that go to the creator, the whole fee is accounted for.
        </p>
        <h3>Rule 2: graduation fees</h3>
        <p>
          When a curve graduates, the part of the raise that does not go into the pool is the
          graduation fee. It splits: 5,000 bps to the house, 2,500 to Confetti, 2,500 to the Vault.
          Confetti is the graduation bonus paid into the token&apos;s pot, so the people holding the
          token at that moment receive it. If the token has no pot, the Confetti share goes to the
          Vault instead.
        </p>
        <h3>Rule 3: penalties</h3>
        <p>
          A penalty is a charge on a specific behaviour: sniping, dumping early, or moving the price
          too far in one sell. 8,000 bps of every penalty go to the holders, through the token&apos;s
          pot, or through the Vault if the creator chose &quot;penalties to vault&quot;. 2,000 bps go
          to the Bag. The Bag splits its 2,000 as 5,000 to the house, 2,500 to Payday and 2,500 to
          the burn. There is no Vault leg on a penalty.
        </p>
        <h3>Rule 4: launch fees and boosts</h3>
        <p>
          A launch fee and a boost purchase go 100% to the house (<code>takeHouseFee</code>).
        </p>
        <h3>The house coin&apos;s own trades</h3>
        <p>
          When the house coin trades, its trade leg into the Bag splits 5,000 bps to the Vault and
          5,000 to the burn. Nothing of it goes to the house.
        </p>
        <div className="doc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th className="num">House</th>
                <th className="num">Vault</th>
                <th className="num">Payday</th>
                <th className="num">Burn</th>
                <th className="num">Confetti</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Trade fee, of the Bag&apos;s 70 bps</td><td className="num">2,856</td><td className="num">4,286</td><td className="num">1,429</td><td className="num">1,429</td><td className="num">0</td></tr>
              <tr><td>Trade fee, measured on the whole 1%</td><td className="num">20 bps</td><td className="num">30 bps</td><td className="num">10 bps</td><td className="num">10 bps</td><td className="num">0</td></tr>
              <tr><td>Graduation fee</td><td className="num">5,000</td><td className="num">2,500</td><td className="num">0</td><td className="num">0</td><td className="num">2,500</td></tr>
              <tr><td>Penalties, the Bag&apos;s 2,000 bps</td><td className="num">5,000</td><td className="num">0</td><td className="num">2,500</td><td className="num">2,500</td><td className="num">0</td></tr>
              <tr><td>Launch fees and boosts</td><td className="num">10,000</td><td className="num">0</td><td className="num">0</td><td className="num">0</td><td className="num">0</td></tr>
              <tr><td>House coin trade leg</td><td className="num">0</td><td className="num">5,000</td><td className="num">0</td><td className="num">5,000</td><td className="num">0</td></tr>
            </tbody>
          </table>
        </div>
        <p className="doc-small">
          Splits are in basis points of the row&apos;s source unless the cell says bps of the whole
          fee. 10,000 bps is 100%. Confetti with no pot goes to the Vault.
        </p>
        <h3>While the house coin does not exist</h3>
        <p>
          The Vault can only pay people who lock the house coin, and the burn clock can only burn
          it. Until the coin exists, the Bag keeps the Vault&apos;s share on its own books
          (<code>heldForVault</code>). Anyone can call <code>releaseHeld</code> later and move it to
          the Vault. A burn that fails is kept the same way (<code>heldForBurn</code>). Nothing is
          lost and nothing can be withdrawn by anyone.
        </p>
      </section>

      <section className="panel" id="pot">
        <h2>The token&apos;s pot</h2>
        <p>
          Every token has a pot. The pot is the contract that pays the token&apos;s holders. On a curve
          launch the pot is a <code>HoodPot</code>. On a direct launch the revenue splitter plays the
          pot. Either way the pot works the same. It keeps a per-share accumulator: every deposit is
          divided over the eligible supply, and each holder&apos;s claim grows with the balance they
          hold. The token calls <code>syncBalances</code> on the pot on every balance move, so the
          books are always current. A deposit that arrives while nobody is eligible is credited at
          the next sync.
        </p>
        <p>
          Some addresses never earn: the curve, the graduator, the pot itself, the first-buy locker,
          the staking contract, the PoolManager and the hook. Everybody else who holds the token
          earns from the pot.
        </p>
        <h3>What fills a pot</h3>
        <ul>
          <li>Confetti, a quarter of the graduation fee, at the moment the token graduates.</li>
          <li>
            Penalties: 8,000 bps of every one, unless the creator chose &quot;penalties to vault&quot;.
            On a direct launch with king of the hill on, part of that share goes to the king pot
            instead.
          </li>
          <li>The dividends leg of the creator&apos;s tax, on a direct launch that has one.</li>
          <li>Half of the winning bid of the sniper auction, on a direct launch that ran one.</li>
          <li>Payday&apos;s slice for the ten most recent launches.</li>
          <li>The creator slash on a direct launch: every unclaimed creator fee, when the creator sells.</li>
        </ul>
        <h3>How holders are paid</h3>
        <p>
          <code>claim(account)</code> is permissionless. Anyone can call it for any holder, and the
          money always goes to that holder. <code>pushMany(accounts, floor)</code> is permissionless
          too. It pays every listed holder whose claim is above the floor. The keeper calls it every
          5 minutes with a floor of 0.0001 ETH (1e14 wei), and the keeper pays the gas. A holder whose
          claim is below the floor waits until it grows past it, or claims it himself.
        </p>
      </section>

      <section className="panel" id="payday">
        <h2>Payday</h2>
        <p>
          Payday (<code>HoodPayday</code>) pays traders every hour. An epoch is one hour. After an
          hour closes, the keeper, or the factory owner, calls <code>pay</code> for that hour, once
          per hour per asset. One payout covers at most 500 wallets and 10 pots. Up to 10% (1,000
          bps) of the hour&apos;s money goes to the pots of the ten most recent launches, so the holders
          of the newest tokens get a bonus. The rest goes to wallets in proportion to their points
          for that hour. Anything not paid carries into the next hour. Claims under the dust floor of
          1e13 wei are not paid.
        </p>
        <p>
          The keeper chooses who is on the list. It cannot choose how much an hour pays in total: an
          hour pays at most what it holds, and never twice.
        </p>
        <p>
          What pays into Payday: 10 bps of every trade (rule 1) and a quarter of the Bag&apos;s 2,000
          bps of every penalty (rule 3), which is 5% of every penalty.
        </p>
        <h3>Points</h3>
        <p>
          Points are computed off the chain by our API, from the trades, launches, locks and
          referrals it indexes. They are not a token and not a balance. They only decide how an
          hour&apos;s Payday, and a season&apos;s drop, split between wallets.
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
              <tr><td>Lock the house coin</td><td>10 per dollar per 30 days locked, times the lock multiplier</td></tr>
              <tr><td>Bounty</td><td>1, for holding a token at the moment a bot paid a penalty on it</td></tr>
              <tr><td>Rank</td><td>multiplies the rows above by 1.5x to 5x, set by your 30-day volume</td></tr>
              <tr><td>Referral</td><td>10% of the trading points of the wallet you referred, on top of theirs, not multiplied</td></tr>
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
      </section>

      <section className="panel" id="vault">
        <h2>The Vault</h2>
        <p>
          The Vault (<code>HoodStaking</code>) pays people who lock the house coin. The house coin is
          the platform&apos;s own token. It has not launched yet. When it does, the factory owner sets
          it in the Vault once, and after that it cannot change. The Vault stakes only that coin.
          Until then the Vault holds nothing, and its share of every fee waits in the Bag.
        </p>
        <h3>Lock tiers</h3>
        <div className="doc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Lock</th>
                <th className="num">Multiplier</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Flexible, no lock</td><td className="num">1x</td></tr>
              <tr><td>7 days</td><td className="num">1.25x</td></tr>
              <tr><td>30 days</td><td className="num">1.5x</td></tr>
              <tr><td>90 days</td><td className="num">2x</td></tr>
              <tr><td>180 days</td><td className="num">2.5x</td></tr>
            </tbody>
          </table>
        </div>
        <p>
          A lock longer than 365 days reverts. A lock between two tiers gets the multiplier of the
          tier it reached, rounded down. The multiplier is the weight of the position when rewards
          are shared out.
        </p>
        <h3>What pays in</h3>
        <ul>
          <li>The Bag&apos;s Vault legs: 30 bps of every trade, a quarter of every graduation fee, and half of the house coin&apos;s own trade leg.</li>
          <li>The stakers leg of the curve fee router, when a curve creator chose to send part of his share to the Vault.</li>
          <li>Penalties on a token whose creator chose &quot;penalties to vault&quot;.</li>
          <li>Confetti from a graduated launch that has no pot.</li>
        </ul>
        <p>
          Rewards arrive in up to 8 assets, native ETH, USDG and any quote asset a token trades in,
          through <code>notifyReward</code>. A position is owed a list of assets, not one number.
        </p>
        <h3>Claiming, unlocking, demoting</h3>
        <p>
          <code>claim(id)</code> is permissionless and pushes every asset to the owner of the
          position, never to the caller. Rewards that arrive while nothing is staked go to the first
          staker. A position can be unstaked only after its unlock time. <code>demote(id)</code> is
          permissionless after unlock and resets the position to 1x, so an expired lock does not
          keep its weight.
        </p>
        <p>
          The first-buy locker (<code>HoodTokenLock</code>) is a separate contract. It holds a
          creator&apos;s own first buy for 7, 30, 90 or 180 days. It earns nothing. It is a statement
          about the creator, not a yield.
        </p>
      </section>

      <section className="panel" id="burn">
        <h2>The burn clock</h2>
        <p>
          The burn clock (<code>HoodBurnClock</code>) buys the house coin and burns it. There is one
          burn per asset per hour, called by the keeper or the factory owner. A burn may move the
          pool&apos;s price by at most 296 ticks, which is about 3%. What does not fit waits for the
          next hour. The clock spends only the asset the house coin&apos;s pool is quoted in. Any other
          asset it was funded with stays in the clock forever: it has no owner and no withdrawal
          function. The coin is burned through <code>burn()</code> when it has one, or by sending it
          to <code>0x...dEaD</code>.
        </p>
        <p>
          Until the factory owner sets the house coin once (<code>setHouseCoin</code>), every burn
          reverts with <code>NoHouseCoin</code>. The money waits.
        </p>
        <p>
          What pays into the burn: 10 bps of every trade, a quarter of the Bag&apos;s 2,000 bps of every
          penalty, and half of the house coin&apos;s own trade leg.
        </p>
      </section>

      <section className="panel" id="graduation">
        <h2>Graduation and Confetti</h2>
        <p>
          A curve graduates when it sells out. The curve stops trading, and anyone can call{" "}
          <code>finalize()</code>. The pool was already prepared at launch, so nobody can open it at
          a wrong price before graduation. At graduation the price is pinned to the ratio the raise
          came out at. If the pool already has liquidity from somebody else, the pin must land within
          a 5% band of the pool&apos;s price. The liquidity is full range. The position NFT stays in the
          graduator, which has no transfer function and no decrease-liquidity function. The lock is
          the absence of code, not a promise.
        </p>
        <p>
          The graduation fee is the part of the raise that does not go into the pool. The factory
          requires at least 8,000 bps of the raise to go to liquidity. On presets 0 and 2 it is
          9,000 bps, so the fee is 10% of the raise. On preset 1 it is 9,500 bps, so the fee is 5%.
          The fee goes to the Bag and follows rule 2: half to the house, a quarter to the Vault, a
          quarter to Confetti. Confetti is paid into the token&apos;s pot at that moment, so everyone
          holding the token when it graduates gets a share.
        </p>
        <p>
          After graduation the token trades on its pool. Every trade pays the 1% fee (30 bps to the
          creator, 70 to the Bag) and the pool&apos;s own 0.3% fee. The pool fee accrues to the locked
          position. Anyone can call <code>collect</code>: the token side is burned and the quote side
          goes to the creator&apos;s fee split. If the creator set a jeet tax or a whale tax at launch,
          they wake up now, applied by the graduation hook.
        </p>
      </section>

      <section className="panel" id="penalties">
        <h2>Penalties and the creator&apos;s options</h2>
        <p>
          A penalty is an extra charge on a specific behaviour. The creator sets each one at launch,
          and none can change afterwards. Every penalty splits the same way: 8,000 bps to the
          holders, through the token&apos;s pot or through the Vault if the creator chose
          &quot;penalties to vault&quot;, and 2,000 bps to the Bag, which splits its part half to the
          house, a quarter to Payday and a quarter to the burn.
        </p>
        <div className="doc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Who pays</th>
                <th>Who gets it</th>
                <th>Limits</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Snipe tax (direct only)</td>
                <td>A buyer in the first seconds after launch</td>
                <td>8,000 bps holders, 2,000 bps the Bag</td>
                <td>Starts at the creator&apos;s rate and decays quadratically to zero over up to 600 seconds. The app&apos;s default is 50% over 3 seconds. Tax plus snipe surcharge never above 9,900 bps.</td>
              </tr>
              <tr>
                <td>Opening window caps (direct only)</td>
                <td>Nobody. A buy over the cap reverts.</td>
                <td>Nobody</td>
                <td>Lasts up to 1,200 blocks, about 2 minutes at 100 ms blocks; default 30 blocks. Per-wallet hold cap and buy cap; the buy cap is at most 1.1x the hold cap.</td>
              </tr>
              <tr>
                <td>Jeet tax</td>
                <td>A seller who sells within the window after buying</td>
                <td>8,000 bps holders, 2,000 bps the Bag</td>
                <td>At most 2,500 bps. The window is at most 1 hour after the buy.</td>
              </tr>
              <tr>
                <td>Whale tax</td>
                <td>A seller whose sell moves the price more than the creator&apos;s tick limit</td>
                <td>8,000 bps holders, 2,000 bps the Bag</td>
                <td>At most 2,500 bps. The tick limit is at most 2,000 ticks. A graduated pool with penalties refuses exact-output sells.</td>
              </tr>
              <tr>
                <td>King of the hill (direct only)</td>
                <td>Comes out of the holders&apos; share of every penalty</td>
                <td>The king, when the timer runs out</td>
                <td>Up to 5,000 bps of the holders&apos; 8,000. Timer 60 seconds.</td>
              </tr>
              <tr>
                <td>Penalties to vault</td>
                <td>Same payers as above</td>
                <td>The Vault instead of the token&apos;s pot</td>
                <td>On or off, chosen at launch.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          A curve launch has no penalties while it is on the curve. The jeet tax and the whale tax
          the creator chose apply after graduation, on the pool. The snipe tax, the opening window,
          king of the hill, the sniper auction and the creator slash exist only on direct launches.
        </p>
      </section>

      <section className="panel" id="king">
        <h2>King of the hill</h2>
        <p>
          King of the hill is an option on direct launches. When it is on, up to half (5,000 bps) of
          the holders&apos; share of every penalty goes into the king pot instead of the token&apos;s pot.
          A buy takes the crown only if it is worth at least a hundredth of the pot. The crown holds
          for 60 seconds after the last crowned buy. When the timer runs out, the king takes the pot.
          Anyone can settle it. Then the pot starts filling again as penalties come in.
        </p>
        <p>
          Who pays: the people who pay penalties. Who gets paid: the last wallet crowned. When: 60
          seconds after the last crown, once somebody settles.
        </p>
      </section>

      <section className="panel" id="auction">
        <h2>The sniper auction</h2>
        <p>
          The sniper auction is an option on direct launches. The creator&apos;s own launch block is
          his. The auction sells the first slot after it to the highest bidder, instead of to the
          fastest bot. The window runs for up to 300 blocks after the launch block. While it is open,
          nobody can buy from the pool.
        </p>
        <ul>
          <li>Bids are in the launch&apos;s quote asset. For a native quote the minimum bid is the launch fee.</li>
          <li>Each bid must beat the last one by 5%.</li>
          <li>The bidder who was outbid is refunded on the spot. If the refund cannot be delivered, it is booked and can be taken with <code>claimRefund</code>.</li>
          <li>After the window closes, the winner alone may receive tokens from the pool for 20 blocks.</li>
          <li>Anyone can settle once the window has closed. Half of the winning bid goes to the token&apos;s pot for the holders. Half goes to the locker as liquidity.</li>
          <li>If nobody bids, the pool simply opens after the window.</li>
        </ul>
      </section>

      <section className="panel" id="slash">
        <h2>The creator slash</h2>
        <p>
          The creator slash exists on direct launches. When the creator, or whoever currently
          receives the creator&apos;s fees, sells into the pool, every unclaimed creator fee moves to the
          holders&apos; accumulator in the same transaction. The holders get paid. The creator gets
          nothing from it. A creator who wants to keep his fees does not sell into his own pool.
        </p>
      </section>

      <section className="panel" id="boosts">
        <h2>Boosts and the launch fee</h2>
        <p>
          The launch fee is 0.002 ETH. The factory owner can raise it, up to a cap of 0.01 ETH. The
          creator pays it in the launch transaction. It goes 100% to the house.
        </p>
        <p>
          A boost is a paid slot on the board for one hour. Boosts (<code>HoodBoosts</code>) sell 4
          slots per hour. The default price is 0.005 ETH; the factory owner can set it, up to 0.05
          ETH. A slot can be bought for the current hour or the next one. One token can hold one slot
          per hour. All proceeds go to the house.
        </p>
      </section>

      <section className="panel" id="referrals">
        <h2>Referrals</h2>
        <p>
          There are two referral systems, one on the chain and one off it.
        </p>
        <p>
          On the chain, the owner can set a referral cut per token in the referrals registry: a
          referrer address and a share, at most 5,000 bps of the Bag&apos;s share of that token&apos;s
          fees. The cut only ever comes from the protocol&apos;s side. It never touches the creator&apos;s
          30 bps or a holder&apos;s dividends.
        </p>
        <p>
          Off the chain, a wallet that arrives through your referral link is tied to you. You earn
          10% of that wallet&apos;s trading points, on top of theirs, not out of theirs. Referral points
          are not multiplied by rank.
        </p>
      </section>

      <section className="panel" id="season">
        <h2>The season drop</h2>
        <p>
          The season drop (<code>HoodSeasonDrop</code>) is a share of what the protocol earned in a
          season, split by points. Off the chain, the pool is 30% of the season&apos;s protocol take. On
          the chain it works like this:
        </p>
        <ul>
          <li>A season is a Merkle tree: every wallet with points has a leaf with its amount.</li>
          <li>The owner opens a season and funds it in the same transaction. A season is never opened empty.</li>
          <li>A season stays open for at least 30 days.</li>
          <li>Claims are permissionless. Anyone can claim for anyone, and the money always goes to the listed account.</li>
          <li>After the deadline the owner can sweep what was not claimed back to the treasury.</li>
          <li>There is no rescue function. The owner cannot take funds out of an open season.</li>
        </ul>
        <p>
          No token is promised. The drop pays in the assets the protocol earned. A quiet season pays
          a small pool.
        </p>
      </section>

      <section className="panel" id="keeper">
        <h2>On the chain and off the chain</h2>
        <p>
          The contracts hold the money and apply the rules. The keeper is our off-chain service. It
          calls the contracts on a schedule and pays the gas. The API is our indexer: it reads the
          chain and computes points. Here is who does what.
        </p>
        <div className="doc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>What</th>
                <th>Where it runs</th>
                <th>Who can do it</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Fee splits, the Bag&apos;s rules, pots, penalties, the auction, king of the hill</td><td>On the chain</td><td>Nobody can change them</td></tr>
              <tr><td>Pushing pot payouts to holders</td><td>On the chain; the keeper calls <code>pushMany</code> every 5 minutes with a 0.0001 ETH floor</td><td>Anyone</td></tr>
              <tr><td>Payday for a closed hour</td><td>On the chain; the keeper calls <code>pay</code> every hour</td><td>The keeper or the factory owner</td></tr>
              <tr><td>The hourly burn</td><td>On the chain; the keeper calls it every hour</td><td>The keeper or the factory owner</td></tr>
              <tr><td><code>finalize</code>, <code>collect</code>, auction and king settle, <code>claim</code>, <code>demote</code>, <code>releaseHeld</code></td><td>On the chain</td><td>Anyone</td></tr>
              <tr><td>Points, ranks, the leaderboard, referral points, dollar prices</td><td>Off the chain, in the API</td><td>Us. The API can be rebuilt from the chain, but it is not the chain.</td></tr>
              <tr><td>A season&apos;s Merkle root</td><td>Built off the chain, written on the chain</td><td>The owner opens and funds it</td></tr>
            </tbody>
          </table>
        </div>
        <p>
          If the keeper stops, holders can claim from their pots themselves, and anyone can push
          for them. Payday and the burn wait for the keeper or the owner; the money stays where it
          is until then.
        </p>
      </section>

      <section className="panel" id="guarantees">
        <h2>What is guaranteed and what is not</h2>
        <h3>Guaranteed by the absence of code</h3>
        <ul>
          <li>The Bag has no owner and no withdrawal function. Its four rules are constants. Its outlets are immutable.</li>
          <li>A token has a fixed supply, no owner and no mint function.</li>
          <li>A live token&apos;s fees, taxes, penalties and options cannot be changed by anyone.</li>
          <li>Graduated liquidity is locked. The graduator has no transfer function and no decrease-liquidity function.</li>
          <li>The burn clock has no owner and no withdrawal function.</li>
          <li>A pot pays its holders and nobody else. Claims are permissionless and always pay the holder.</li>
          <li>The season drop has no rescue function. Claims always pay the listed account.</li>
        </ul>
        <h3>Not guaranteed</h3>
        <ul>
          <li>Points are off the chain. The API computes them, and the keeper submits the list Payday pays. The contract only limits how much an hour can pay.</li>
          <li>The house coin is not launched. The Vault and the burn clock wait for it. Their shares wait in the Bag.</li>
          <li>The Safe has not accepted ownership yet. The deployer wallet still owns the factory, the portal, the referrals registry and the bridge factory.</li>
          <li>The factory owner can change things for new launches only: presets, the launch fee (up to 0.01 ETH), the boost price (up to 0.05 ETH), referral cuts (up to 5,000 bps of the Bag&apos;s share), the keeper address, and the house coin, once. The owner cannot touch a live token, the Bag, or locked liquidity.</li>
          <li>The keeper&apos;s timing. A push every 5 minutes and a payout every hour are what we run, not what the chain enforces.</li>
          <li>Nothing here promises a price, a yield or a return.</li>
        </ul>
      </section>

      <section className="panel" id="risks">
        <h2>Risks</h2>
        <ul>
          <li>Most tokens go to zero. A launch is somebody else&apos;s token, not ours. Check the address before you buy.</li>
          <li>A creator&apos;s terms are fixed but they can be harsh: a tax of up to 10% per side, penalties of up to 25%, and a snipe tax that starts high in the first seconds. Read the token page first.</li>
          <li>Contracts can have bugs. This paper does not claim an independent audit.</li>
          <li>The keeper can be late. Payouts that depend on it wait until it, or the owner, calls.</li>
          <li>Points and the season pool are a score and a policy, not a balance owed to you.</li>
          <li>Robinhood Chain is a young chain with 100 ms blocks. The public RPC can lag or refuse a request, and the app can show stale numbers while it catches up. The chain is authoritative.</li>
          <li>The house coin does not exist yet. Nothing here promises it a date, a price or a yield.</li>
        </ul>
      </section>

      <section className="panel doc-addresses" id="addresses">
        <h2>Contract addresses</h2>
        <p>
          Robinhood Chain, chain id 4663. Deployed on 25 September 2026; the first receipt is in
          block 72198515. Source is verified on the chain&apos;s Blockscout explorer.
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
          Pending: the house coin is not set in the Vault or the burn clock. The Safe has not accepted
          ownership; the deployer wallet still owns the factory, the portal, the referrals registry
          and the bridge factory.
        </p>
      </section>

      <p className="doc-foot">
        Step-by-step instructions are in the <Link href="/docs">docs</Link>. The terms are at{" "}
        <Link href="/terms">/terms</Link>. This paper is not financial advice.
      </p>
    </div>
  );
}
