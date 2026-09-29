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
  ["what", `What ${brand.name} is`],
  ["launch", "Two ways to launch"],
  ["cost", "What a trade costs"],
  ["bag", "The Bag"],
  ["pot", "The token's pot"],
  ["payday", "Payday"],
  ["vault", "The Vault"],
  ["burn", "The burn clock"],
  ["graduation", "Graduation"],
  ["opening", "The opening tax"],
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
  ["Factory (HoodFactory)", "0x14226252c5C5526c76Ec1370246c77d108dBfb4B"],
  ["The Bag (HoodBag)", "0x471EE5dA3fD9B9C8B186B7e9DAD72270463e36d3"],
  ["Payday (HoodPayday)", "0xA76759C5818cAFa348071027Fc6cD903adA81195"],
  ["Burn clock (HoodBurnClock)", "0xA542876A28d9954e88922785bE70D79B18a8Fc4F"],
  ["Boosts (HoodBoosts)", "0xADE405A64379C5A2A00cE84A4af61bB0b0ec42D0"],
  ["Graduation hook", "0x4ff4F5175c9057E40413068bBE6F4c55D45000cC"],
  ["Portal (direct launches)", "0x8f9F4221b211549bE2F06a2bAFa05DE089182c77"],
  ["Block zero (HoodBlockZero)", "0xeD04C668C53de1EEa4cB5361014C90C731739c0E"],
  ["The Vault (HoodStaking)", "0xdC5af0613e5f2B5fBcFC2131dc93E6FF4cbB118D"],
  ["Fee router (HoodFeeRouter)", "0xd2c0c656d7395248eD7B4F08d64D247Fe0bb63aa"],
  ["Referrals (HoodReferrals)", "0x91F7766c60c621940ce8360999Debec8ddA9078b"],
  ["Graduator (UniswapV4Graduator)", "0x057180612d111E36075893a9dD816E028662069D"],
  ["Curve router (HoodCurveRouter)", "0xb88dB2C54f8087E521F06321429389B02ba152eD"],
  ["First-buy locker (HoodTokenLock)", "0xDb249D05570B60CF2C923938Ba5def9048AA65E5"],
  ["Bridge factory (HoodBridgeFactory)", "0xdB1Caff9854973959f38bB7096EE1b8Ed6f25902"],
  ["Direct deployer (HoodDirectDeployer)", "0xd49EF209d1C1c5AdDD8065A884a7037e3A4fA340"],
  ["Launch token implementation (HoodLaunchToken)", "0xc2E2d993A45b398981DBfa1064BEC78F74D48F7F"],
  ["Buyback module (HoodBuybackModule)", "0x4ea89c4c8bD249d9958586602Cde6ebc4EA2D94F"],
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
          Version 4. Contracts deployed on Robinhood Chain (chain id 4663) on 29 September 2026.
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
          Most of that fee goes back to the people who use the site. The creator of each token gets
          70% of it. Traders are paid every hour by Payday. People who lock the house coin are paid
          by the Vault. Every graduation pays the burn clock, which buys the house coin and burns
          it. Our own share is called the house. Each of these has a section below.
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
          then call <code>finalize()</code>. The token graduates: 90% of the money the curve raised
          and the 20% of supply go into a Uniswap v4 pool, and that liquidity is locked forever.
        </p>
        <h3>The direct pool</h3>
        <p>
          The portal creates the token and puts the whole supply into a Uniswap v4 pool in the
          launch transaction. There is no curve and no raise. A hook, a contract attached to the
          pool, takes the fee and the creator&apos;s optional tax on every swap. Anyone may buy any
          amount from the first block. There are no per-wallet caps and no reserved launch block.
        </p>
        <p>
          Both shapes open the same way: a fixed <a href="#opening">opening tax</a> on buys in the
          first three seconds, the same on every launch.
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
          the asset the token is priced in: ETH or USDG. The fee splits in two. 70 bps go to the
          creator&apos;s split. 30 bps go to the Bag. The Bag is the contract that receives the
          protocol&apos;s share of every fee and splits it by fixed rules. It has its own section.
        </p>
        <ul>
          <li>
            On a curve launch the two numbers come from the preset. Every preset today sends 70 bps
            to the creator and 30 bps to the Bag. The factory refuses a preset where the two add up
            to more than 500 bps.
          </li>
          <li>
            On a direct launch, and on every graduated pool, the two numbers are hardcoded: 70 bps
            to the creator, 30 bps to the Bag.
          </li>
          <li>
            The creator chooses at launch where the 70 bps go. On a curve launch the fee split has
            four legs: the creator, a buyback that burns the token, liquidity, and house-coin
            stakers (the Vault). On a direct launch the allocations have four legs: the creator, a
            buyback, dividends to holders, and liquidity.
          </li>
          <li>
            A graduated pool is a Uniswap v4 pool, and the pool charges its own fee of 0.3% on top
            (poolFee 3000, tickSpacing 60). That fee accrues to the locked liquidity position.
            Anyone can call <code>collect</code> on the graduator. The token side is burned. The
            quote side goes to the creator&apos;s fee split.
          </li>
          <li>
            On a direct launch the creator can add a tax of their own, from 1% to 10% per side (100
            to 1,000 bps). The trader pays it on top of the 1%. All of it follows the creator&apos;s
            allocations, which add up to 100%.
          </li>
          <li>
            A buy in the first three seconds after any launch pays the{" "}
            <a href="#opening">opening tax</a> on top. On a direct pool the creator&apos;s tax, the 1%
            and the opening tax together can never take more than 99% (9,900 bps) of a buy.
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
              <tr><td>Creator&apos;s share of the trade fee</td><td>70 bps</td></tr>
              <tr><td>The Bag&apos;s share of the trade fee</td><td>30 bps</td></tr>
              <tr><td>Cap on Bag plus creator, curve presets</td><td>500 bps together</td></tr>
              <tr><td>Graduated pool LP fee, on top</td><td>0.3% (poolFee 3000, tickSpacing 60)</td></tr>
              <tr><td>Creator tax, direct launches</td><td>100 to 1,000 bps per side (1% to 10%)</td></tr>
              <tr><td>Opening tax, every launch, buys only</td><td>9,900 bps in second 0, 618 in second 1, 19 in second 2, then 0</td></tr>
              <tr><td>Creator tax plus 1% plus opening tax, direct pool</td><td>at most 9,900 bps of a buy</td></tr>
              <tr><td>Referral cut</td><td>at most 5,000 bps of the Bag&apos;s share, never the creator&apos;s</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" id="bag">
        <h2>The Bag</h2>
        <p>
          The Bag (<code>HoodBag</code>) receives the protocol&apos;s share of every fee and splits it.
          Who gets paid depends on where the money came from. The rules are constants in a library:
          nobody can edit them. The Bag has no owner and no withdrawal function. The addresses it
          pays, the house, the Vault, Payday and the burn clock, are set when it is deployed and
          cannot change. The house is the team&apos;s treasury Safe.
        </p>
        <h3>Rule 1: trade fees</h3>
        <p>
          The 30 bps the Bag receives from a trade split three ways: 3,333 bps to the Vault, 3,333 to
          Payday, and the rest, 3,334, to the house. Measured against the whole 1% a trade pays,
          that is 10 bps to the Vault, 10 to Payday and 10 to the house. With the 70 bps that go to
          the creator, the whole fee is accounted for: creator 70%, Vault 10%, Payday 10%, house
          10%. The opening tax enters the Bag through this same door and splits the same way.
        </p>
        <h3>Rule 2: graduation fees</h3>
        <p>
          When a curve graduates, the 10% of the raise that does not go into the pool is the
          graduation fee. It splits: 2,300 bps to the launch&apos;s creator fee recipient as the dev
          bonus, and 7,700 to the burn clock. A launch with no fee recipient sends the whole fee to
          the burn clock.
        </p>
        <h3>Rule 3: boosts</h3>
        <p>
          A boost purchase goes 100% to Payday, booked to the hour the boost runs.
        </p>
        <h3>Rule 4: launch fees</h3>
        <p>
          A launch fee goes 100% to the house (<code>takeHouseFee</code>).
        </p>
        <h3>The house coin&apos;s own trades</h3>
        <p>
          When the house coin trades, the Bag&apos;s 30 bps of that trade go 100% to the Vault. The
          house coin&apos;s own creator split is set when the house coin is launched. The plan is 25%
          to liquidity, 25% to the burn, 40% to the Vault and 10% to the house. It is not live.
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
                <th className="num">Dev bonus</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Trade fee, of the Bag&apos;s 30 bps</td><td className="num">3,334</td><td className="num">3,333</td><td className="num">3,333</td><td className="num">0</td><td className="num">0</td></tr>
              <tr><td>Trade fee, measured on the whole 1%</td><td className="num">10 bps</td><td className="num">10 bps</td><td className="num">10 bps</td><td className="num">0</td><td className="num">0</td></tr>
              <tr><td>Graduation fee</td><td className="num">0</td><td className="num">0</td><td className="num">0</td><td className="num">7,700</td><td className="num">2,300</td></tr>
              <tr><td>Boosts</td><td className="num">0</td><td className="num">0</td><td className="num">10,000</td><td className="num">0</td><td className="num">0</td></tr>
              <tr><td>Launch fees</td><td className="num">10,000</td><td className="num">0</td><td className="num">0</td><td className="num">0</td><td className="num">0</td></tr>
              <tr><td>House coin trades, the Bag&apos;s 30 bps</td><td className="num">0</td><td className="num">10,000</td><td className="num">0</td><td className="num">0</td><td className="num">0</td></tr>
            </tbody>
          </table>
        </div>
        <p className="doc-small">
          Splits are in basis points of the row&apos;s source unless the cell says bps of the whole
          fee. 10,000 bps is 100%. A dev bonus the recipient refuses is booked and can be pushed
          again by anyone.
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
          <li>The dividends leg of the creator&apos;s allocations, on a direct launch that has one.</li>
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
          What pays into Payday: 10 bps of every trade (rule 1) and every boost bought for that hour
          (rule 3). Payouts are pushed to the wallets. There is no claim button.
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
              <tr><td>Bounty</td><td>1, for holding a token at the moment a bot paid the opening tax on it</td></tr>
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
          <li>The Bag&apos;s Vault legs: 10 bps of every trade, and all of the Bag&apos;s 30 bps of the house coin&apos;s own trades.</li>
          <li>The stakers leg of the curve fee router, when a curve creator chose to send part of their share to the Vault.</li>
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
          What pays into the burn: 77% of every graduation fee (rule 2). It gets nothing from trades.
          On the standard ETH preset that is about 0.37 ETH per graduation.
        </p>
      </section>

      <section className="panel" id="graduation">
        <h2>Graduation</h2>
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
          The factory requires at least 8,000 bps of the raise to go to liquidity. Every preset
          today uses 9,000 bps. So 90% of the raise, plus the reserved 20% of supply, goes into the
          pool. The other 10% is the graduation fee. It goes to the Bag and follows rule 2: 23% to
          the launch&apos;s creator fee recipient as the dev bonus, 77% to the burn clock.
        </p>
        <div className="doc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Preset</th>
                <th>Quote</th>
                <th className="num">Start valuation</th>
                <th className="num">Graduation valuation</th>
                <th className="num">Raise, about</th>
                <th className="num">To the pool (90%)</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>0</td><td>ETH</td><td className="num">1.1 ETH</td><td className="num">11.025 ETH</td><td className="num">4.85 ETH</td><td className="num">4.365 ETH</td></tr>
              <tr><td>1</td><td>ETH</td><td className="num">2 ETH</td><td className="num">40 ETH</td><td className="num">16.8 ETH</td><td className="num">15.12 ETH</td></tr>
              <tr><td>2</td><td>USDG</td><td className="num">5,500 USDG</td><td className="num">55,125 USDG</td><td className="num">24,250 USDG</td><td className="num">21,825 USDG</td></tr>
            </tbody>
          </table>
        </div>
        <p>
          On preset 0 the graduation fee is about 0.485 ETH: about 0.11 ETH to the creator and
          about 0.37 ETH to the burn clock, which buys the house coin and burns it.
        </p>
        <p>
          After graduation the token trades on its pool. Every trade pays the 1% fee (70 bps to the
          creator&apos;s split, 30 to the Bag) and the pool&apos;s own 0.3% fee. The pool fee accrues to
          the locked position. Anyone can call <code>collect</code>: the token side is burned and
          the quote side goes to the creator&apos;s fee split. A graduated pool charges the fee and
          nothing else.
        </p>
      </section>

      <section className="panel" id="opening">
        <h2>The opening tax</h2>
        <p>
          Every launch opens the same way, on the curve and on a direct pool. The opening tax is not
          a setting, so a buyer never has to read a launch&apos;s config to know what the first
          seconds cost. It charges buys by the second after the launch:
        </p>
        <div className="doc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Second after launch</th>
                <th className="num">Tax on a buy</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>0, the launch&apos;s own second</td><td className="num">99% (9,900 bps)</td></tr>
              <tr><td>1</td><td className="num">6.18% (618 bps)</td></tr>
              <tr><td>2</td><td className="num">0.19% (19 bps)</td></tr>
              <tr><td>3 and later</td><td className="num">0%</td></tr>
            </tbody>
          </table>
        </div>
        <ul>
          <li>Buys only. A seller never pays it.</li>
          <li>It is trading fee, split like the 1%: 70% to the creator&apos;s split, 30% to the Bag, which splits it by rule 1.</li>
          <li>
            Exempt for the whole window: the wallet that launches, the creator fee recipient, and up
            to 32 more wallets the creator names at launch, for example a team spreading its opening
            buys. The list is public on the chain from the launch transaction on.
          </li>
          <li>Buys made inside the launch transaction never pay it: the creator&apos;s first buy and the team wallets of a Block Zero team launch.</li>
          <li>
            On the curve the exemption is keyed on the wallet that receives the tokens. On a direct
            pool it is keyed on the wallet that sends the swap (<code>tx.origin</code>), because the
            hook only sees the router.
          </li>
          <li>On a direct pool the creator&apos;s tax, the 1% and the opening tax together are capped at 99% of a buy.</li>
        </ul>
        <p>
          Who pays: bots and anyone else who buys in the first three seconds without an exemption.
          Who gets paid: the creator and the Bag, like any fee. Holders of the token at that moment
          earn bounty points, and the wallet that paid is listed on the snipers&apos; wall on{" "}
          <Link href="/bag">/bag</Link>.
        </p>
      </section>

      <section className="panel" id="slash">
        <h2>The creator slash</h2>
        <p>
          The creator slash exists on direct launches. When the creator, or whoever currently
          receives the creator&apos;s fees, sells into the pool, every unclaimed creator fee moves to the
          holders&apos; accumulator in the same transaction. The holders get paid. The creator gets
          nothing from it. A creator who wants to keep their fees does not sell into their own pool.
        </p>
      </section>

      <section className="panel" id="boosts">
        <h2>Boosts and the launch fee</h2>
        <p>
          The launch fee is 0.002 ETH. The factory owner can raise it, up to a cap of 0.01 ETH. The
          creator pays it in the launch transaction. It goes 100% to the house.
        </p>
        <p>
          Planned, not live: paying the launch fee and boosts in the house coin at half price, with
          that coin burned.
        </p>
        <p>
          A boost is a paid slot on the board for one hour. Boosts (<code>HoodBoosts</code>) sell 4
          slots per hour. The default price is 0.005 ETH; the factory owner can set it, up to 0.05
          ETH. A slot can be bought for the current hour or the next one. One token can hold one slot
          per hour. All proceeds go to Payday, for the hour the boost runs: the traders who show up
          while the token is boosted are the ones paid for it.
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
          70 bps or a holder&apos;s dividends.
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
              <tr><td>Fee splits, the Bag&apos;s rules, pots, the opening tax</td><td>On the chain</td><td>Nobody can change them</td></tr>
              <tr><td>Pushing pot payouts to holders</td><td>On the chain; the keeper calls <code>pushMany</code> every 5 minutes with a 0.0001 ETH floor</td><td>Anyone</td></tr>
              <tr><td>Payday for a closed hour</td><td>On the chain; the keeper calls <code>pay</code> every hour</td><td>The keeper or the factory owner</td></tr>
              <tr><td>The hourly burn</td><td>On the chain; the keeper calls it every hour</td><td>The keeper or the factory owner</td></tr>
              <tr><td><code>finalize</code>, <code>collect</code>, <code>claim</code>, <code>demote</code>, <code>releaseHeld</code></td><td>On the chain</td><td>Anyone</td></tr>
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
          <li>The Bag has no owner and no withdrawal function. Its rules are constants. Its outlets are immutable.</li>
          <li>A token has a fixed supply, no owner and no mint function.</li>
          <li>A live token&apos;s fees, taxes, exempt wallets and options cannot be changed by anyone.</li>
          <li>The opening tax is the same on every launch and cannot be changed.</li>
          <li>Graduated liquidity is locked. The graduator has no transfer function and no decrease-liquidity function.</li>
          <li>The burn clock has no owner and no withdrawal function.</li>
          <li>A pot pays its holders and nobody else. Claims are permissionless and always pay the holder.</li>
          <li>The season drop has no rescue function. Claims always pay the listed account.</li>
        </ul>
        <h3>Not guaranteed</h3>
        <ul>
          <li>Points are off the chain. The API computes them, and the keeper submits the list Payday pays. The contract only limits how much an hour can pay.</li>
          <li>The house coin is not launched. The Vault and the burn clock wait for it. The Vault&apos;s share waits in the Bag; the burn clock keeps what it is paid.</li>
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
          <li>A creator&apos;s terms are fixed but they can be harsh: a tax of up to 10% per side on a direct pool. Read the token page first.</li>
          <li>A buy in a launch&apos;s own second pays a 99% opening tax. Check the clock before you buy a new launch.</li>
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
          Robinhood Chain, chain id 4663. Deployed on 29 September 2026; the first receipt is in
          block 75134585. Launches made before that keep the rules of the contracts that printed them. Source is verified on the chain&apos;s Blockscout explorer.
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
