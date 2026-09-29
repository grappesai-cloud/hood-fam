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
  ["opening", "The opening tax"],
  ["team", "Team launches"],
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
  ["/creator", "Your launches: what each is worth now, and the transactions that are yours to send."],
  ["/following", "The traders you follow and the launches you watch."],
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

const GLOSSARY: [string, string][] = [
  ["The Bag", "The contract that receives the protocol's share of every fee and splits it by fixed rules. No owner, no withdrawal."],
  ["The house", "Our share, paid to the team's treasury Safe. Paid out of the Bag by the rules; never a share of the creator's fees."],
  ["The house coin", "The platform's own token. Not launched yet. The only coin the Vault stakes and the only coin the burn clock burns."],
  ["The token's pot", "The contract that pays a token's holders in proportion to what they hold. A HoodPot on curve launches, the revenue splitter on direct launches."],
  ["Payday", "The hourly payout to traders, split by points, with a slice for the pots of the ten newest launches."],
  ["The Vault", "The staking contract for the house coin. Lock tiers from flexible (1x) to 180 days (2.5x). Rewards arrive in the assets the fees were paid in."],
  ["The burn clock", "The contract that buys the house coin once an hour and burns it. It is fed by 77% of every graduation fee. It can spend one asset only, the one the house coin's pool is quoted in. A burn share paid in any other asset stays in the clock."],
  ["The keeper", "Our off-chain service. It pushes pot payouts every 5 minutes, calls Payday and the burn every hour, and pays the gas."],
  ["The curve", "A bonding curve: a contract that sells a token at a price that rises as more is sold, then graduates into a pool when it sells out."],
  ["Direct pool", "A launch whose whole supply goes straight into a Uniswap v4 pool, with a hook that takes the fee and the creator's terms on every swap."],
  ["The hook", "The contract attached to a direct launch's pool. It applies the fee, the creator's tax and the opening tax."],
  ["Graduation", "The moment a curve sells out and 90% of its raise plus the reserved 20% of supply become locked liquidity in a pool."],
  ["Graduation fee", "The 10% of a curve's raise that does not go into the pool. 23% of it goes to the creator as the dev bonus, 77% to the burn clock."],
  ["Dev bonus", "The creator's 23% of the graduation fee, paid to the launch's creator fee recipient when the curve graduates."],
  ["The graduator", "The contract that opens a graduated pool and keeps the position forever. It has no transfer and no decrease-liquidity function."],
  ["Preset", "A fixed set of curve parameters: start cap, graduation cap, share of the raise that goes to liquidity, fees."],
  ["Quote asset", "What a token is priced in and what fees are paid in: ETH or USDG."],
  ["bps", "Basis points. 100 bps is 1%. 10,000 bps is 100%."],
  ["Creator leg", "70 bps of every 1% trade fee. It goes to the creator's fee split on a curve launch and to the creator's allocations on a direct launch."],
  ["Fee split", "On a curve launch, how the creator leg splits: creator, buyback, liquidity, stakers (the Vault). They add up to 100%."],
  ["Creator tax", "On a direct launch, an extra 1% to 10% per side chosen by the creator and split by the creator's allocations."],
  ["Allocations", "On a direct launch, how the creator leg and the creator's tax split: creator, buyback, dividends to holders, liquidity. They add up to 100%."],
  ["Opening tax", "A fixed tax on buys in the first seconds of every launch, on both machines: 99% in the launch's own second, 6.18% in the next, 0.19% in the one after, then 0%. Split like the trade fee: 70% to the creator leg, 30% to the Bag."],
  ["Exempt wallets", "Wallets that pay no opening tax: the wallet that launches, the creator fee recipient and up to 32 more the creator names at launch. The list is public on chain."],
  ["Open buyer", "The label the token page and the holder map give a wallet the creator named as exempt from the opening tax."],
  ["Block Zero", "A team launch: the token is printed and up to 40 team wallets buy in the same transaction, before anyone else can trade. Every wallet is written on chain."],
  ["Team wallet", "A wallet that bought inside a Block Zero launch. The chain holds what it paid, what it got and when its lock opens. The token page and the holder map label it team."],
  ["The snipers' wall", "The list on the Bag page of the wallets that paid the opening tax."],
  ["The creator slash", "On a direct launch, when the creator sells into the pool, the creator's unclaimed fees move to the holders."],
  ["First-buy lock", "A creator's own first buy held in HoodTokenLock for 7, 30, 90 or 180 days. It earns nothing."],
  ["Copycat lock", "For 48 hours after a launch that did 25 ETH (or 100,000 USDG) of volume in a day, its ticker and image cannot be reused."],
  ["Boost", "A paid slot on the board for one hour. 4 slots an hour. The price goes to the Payday of the hour the boost runs."],
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
          Robinhood Chain, chain id 4663. Contracts deployed 29 September 2026. The whitepaper is at{" "}
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
            Choose your fee split. Your 70 bps of every trade go through the fee router, and you fix
            at launch how they split between four legs: stakers (paid to the Vault), buyback,
            liquidity and creator. A stakers leg is refused until the house coin exists.
          </li>
          <li>
            Optionally name up to 32 wallets that skip the opening tax, for example a team spreading
            its opening buys. You and your fee recipient are always exempt. The list is public on
            the chain from the launch transaction on.
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
          Trading opens at once. The first seconds are priced by the{" "}
          <a href="#opening">opening tax</a>, the same on every launch.
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
              <tr><td>0</td><td>ETH</td><td className="num">1.1 ETH</td><td className="num">11.025 ETH</td><td className="num">4.85 ETH</td><td className="num">9,000 bps</td><td className="num">10% of the raise</td></tr>
              <tr><td>1</td><td>ETH</td><td className="num">2 ETH</td><td className="num">40 ETH</td><td className="num">16.8 ETH</td><td className="num">9,000 bps</td><td className="num">10% of the raise</td></tr>
              <tr><td>2</td><td>USDG</td><td className="num">5,500 USDG</td><td className="num">55,125 USDG</td><td className="num">24,250 USDG</td><td className="num">9,000 bps</td><td className="num">10% of the raise</td></tr>
            </tbody>
          </table>
        </div>
        <p>
          Every preset: supply 1,000,000,000; 80% on the curve; 20% reserved to seed the pool; trade
          fee 1%, of which 70 bps to the creator and 30 bps to the Bag. The factory requires at
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
          <li>Buyers pay the curve, sellers sell back to it. Every trade pays 1%. Buys in the first seconds also pay the opening tax.</li>
          <li>When the curve sells out it stops trading. Anyone, usually the keeper, calls <code>finalize()</code>.</li>
          <li>
            The token graduates. 90% of the raise and the reserved 20% of supply go into a
            full-range Uniswap v4 pool, priced at the ratio the raise came out at. The position stays
            in the graduator forever. On preset 0 that is about 4.365 ETH.
          </li>
          <li>
            The other 10% is the graduation fee. It goes to the Bag: 23% to your creator fee
            recipient as the dev bonus (about 0.11 ETH on preset 0), 77% to the burn clock, which
            buys the house coin and burns it (about 0.37 ETH on preset 0). The fee is paid in the
            asset your launch is quoted in, and the clock can spend only the asset the house
            coin&apos;s pool is quoted in. On a launch quoted in anything else, the clock keeps its
            share and does not spend it.
          </li>
          <li>
            From now on the pool charges 1% plus its own 0.3% fee. The 1% splits the same way: 70 bps
            to your fee split, 30 bps to the Bag. Anyone can call <code>collect</code>: the token
            side is burned and the quote side goes to your fee split.
          </li>
        </ol>
      </section>

      <section className="panel" id="direct">
        <h2>Launch a direct pool</h2>
        <p>
          A direct launch puts the whole supply into a Uniswap v4 pool in the launch transaction.
          The token trades from the first block. A hook on the pool takes the 1% fee, your own tax
          and the opening tax. Every setting below is fixed at launch and cannot change.
        </p>
        <h3>Step by step</h3>
        <ol>
          <li>Open <Link href="/launch">/launch</Link> and choose the direct pool.</li>
          <li>Enter the name, ticker, image and description. Pick the quote asset: ETH or USDG.</li>
          <li>
            Set your tax, 1% to 10% per side (100 to 1,000 bps). Buyers and sellers pay it on top of
            the 1%. Set the allocations: creator, buyback, dividends to holders, liquidity. They must
            add up to 100%. They split your tax and your 70 bps of the 1%.
          </li>
          <li>
            Optionally name up to 32 wallets that skip the opening tax. You and your fee recipient
            are always exempt. On a direct pool the exemption is keyed on the wallet that sends the
            swap (<code>tx.origin</code>). The list is public on the chain.
          </li>
          <li>Optionally set an initial buy. It goes straight through the PoolManager in the launch transaction and pays no opening tax.</li>
          <li>Confirm. You pay the launch fee of 0.002 ETH plus your initial buy. The launch fee goes to the house.</li>
        </ol>
        <h3>Where your tax goes</h3>
        <p>
          The 1% platform fee splits 70 bps to you and 30 bps to the Bag on every trade. Your 70 bps,
          your own tax and 70% of any opening tax land in the token&apos;s revenue splitter and are
          split by your allocations. Your creator leg waits for you to claim it on the token page
          or in your portfolio. The dividends leg
          pays holders through the pot. The buyback leg is spent by a shared module that buys the
          token and burns it. The liquidity leg is pushed into the locked position.
        </p>
        <p className="doc-note">
          If you, or the wallet that receives your fees, sell into your own pool, every creator fee
          you have not claimed moves to the holders in the same transaction. That is the creator
          slash. Claim first, and do not sell into your own pool if you want to keep your fees.
        </p>
        <p>
          Anyone may buy any amount at any time. There is no per-wallet cap and no reserved launch
          block. The first seconds are priced by the opening tax instead.
        </p>
      </section>

      <section className="panel" id="opening">
        <h2>The opening tax</h2>
        <p>
          Every launch opens the same way, on the curve and on a direct pool. It is not a setting.
          A buy pays a tax that depends on how many seconds have passed since the launch:
        </p>
        <div className="doc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Second after launch</th>
                <th className="num">Opening tax on a buy</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>0 (the launch&apos;s own second)</td><td className="num">99%</td></tr>
              <tr><td>1</td><td className="num">6.18%</td></tr>
              <tr><td>2</td><td className="num">0.19%</td></tr>
              <tr><td>3 and later</td><td className="num">0%</td></tr>
            </tbody>
          </table>
        </div>
        <ul>
          <li>Buys only. A sell never pays it.</li>
          <li>It is trading fee and splits like the 1%: 70% to the creator&apos;s split, 30% to the Bag.</li>
          <li>
            Exempt: the wallet that launches, the creator fee recipient, and up to 32 more wallets
            the creator names at launch. The list is public on the chain.
          </li>
          <li>Buys made inside the launch transaction never pay it: the creator&apos;s first buy and the team wallets of a Block Zero team launch.</li>
          <li>
            The token page and the holder map label an exempt wallet <b>open buyer</b>, so you can
            see who was allowed in early and what they hold.
          </li>
          <li>
            On the curve the exemption is keyed on the wallet that receives the tokens. On a direct
            pool it is keyed on the wallet that sends the swap (<code>tx.origin</code>), so a
            contract wallet such as a Safe is not covered there.
          </li>
          <li>On a direct pool the creator&apos;s tax, the 1% and the opening tax together are capped at 99% of a buy.</li>
          <li>A wallet that pays it lands on the snipers&apos; wall on <Link href="/bag">/bag</Link>.</li>
        </ul>
      </section>

      <section className="panel" id="team">
        <h2>Team launches</h2>
        <p>
          A team launch, Block Zero, prints the token and buys for the team in the same
          transaction, before anyone else can trade. It exists on both machines: on the curve
          through <code>HoodBlockZero</code>, on a direct pool through the portal&apos;s{" "}
          <code>createTeamLaunch</code>.
        </p>
        <ul>
          <li>Up to 40 team wallets per launch. The wallet that launches pays for every one of them.</li>
          <li>It is all or nothing. If one buy cannot fill, nothing launches and only gas is spent.</li>
          <li>
            Each team buy can be locked for 7, 30, 90 or 180 days, and each wallet can be sent ETH
            in the same transaction for the transactions it makes later.
          </li>
          <li>
            Buys inside the launch transaction pay no opening tax. A team buy in a later
            transaction pays it like anyone, unless that wallet is exempt.
          </li>
          <li>
            On the curve, a second wave can only be sent by the wallet that launched, and only
            while outside buyers hold no more than a limit that wallet sets in the call. Past the
            limit the call reverts and the team keeps its money.
          </li>
          <li><code>HoodBlockZero</code> has no owner and no settings.</li>
        </ul>
        <h3>What you can see</h3>
        <p>
          Nothing about a team launch is hidden. The launch writes every team wallet on the chain:
          the address, what it paid, what it got and when its lock opens. The token page lists them
          under Team with what each still holds, so you can see whether the team has sold. The
          holder map and the top holders label them <b>team</b>, and label the wallets the creator
          named as exempt from the opening tax <b>open buyer</b>.
        </p>
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
          <li>1% of the trade, always. 70 bps go to the creator, 30 bps to the Bag.</li>
          <li>On a direct launch, the creator&apos;s tax on top: 1% to 10% per side, shown on the token page.</li>
          <li>On a graduated pool, the pool&apos;s own 0.3% fee on top.</li>
          <li>
            A buy in the first three seconds after any launch pays the{" "}
            <a href="#opening">opening tax</a>: 99%, then 6.18%, then 0.19%. From the third second on
            it is 0%. Sells never pay it.
          </li>
        </ul>
        <p>
          Read the terms box on the token page before you buy. On a curve launch nothing but the 1%
          applies after the first three seconds.
        </p>
        <h3>What you see on the tape</h3>
        <p>
          The tape lists every trade on the token: buy or sell, the wallet, the size in the quote
          asset, the tokens moved, the price and the time. Fees and taxes are taken inside the
          transaction, so the amount you paid is more than the pool received on a buy, and the
          amount you received is less than the pool paid on a sell. The Bag page has a second tape
          that lists every fee and where it went.
        </p>
        <h3>Things that can make a trade revert</h3>
        <ul>
          <li>Slippage: the price moved past your limit before the trade landed.</li>
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
          <li>On a direct launch, the dividends leg of the creator&apos;s allocations.</li>
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
          Payday pays traders every hour from 10 bps of every trade and from the boosts bought for
          that hour. The hour&apos;s money is split by points. There is no claim button: the keeper
          sends it to your wallet.
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
              <tr><td>Bounty</td><td>1, for holding a token at the moment a bot paid the opening tax on it</td></tr>
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
          <li>10 bps of every trade on the site, through the Bag.</li>
          <li>All 30 bps the Bag takes from the house coin&apos;s own trades.</li>
          <li>The stakers leg of curve launches whose creator chose one.</li>
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
          boost payment goes to the Payday of the hour the boost runs, so the traders of that hour
          are paid for it.
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
          and a share of at most 5,000 bps of the Bag&apos;s 30 bps of that token&apos;s fees. It comes only
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
          the house, the Vault, Payday, the burn clock and the dev bonuses. It shows the shares held
          for the Vault and the burn while the house coin does not exist. It shows the Payday clock
          for the current hour, the burn clock, the boost slots, the contract addresses and the
          snipers&apos; wall: the wallets that paid the opening tax.
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
          1% of the trade, always: 70 bps to the creator and 30 bps to the Bag. On a direct launch the
          creator&apos;s tax of 1% to 10% per side comes on top. On a graduated pool the pool&apos;s own
          0.3% comes on top. A buy in the first three seconds after a launch also pays the opening
          tax.
        </p>
        <h3>When do I get paid as a holder?</h3>
        <p>
          Every 5 minutes, if your claim is above 0.0001 ETH. The keeper pushes it to your wallet and
          pays the gas. Below the floor, it waits or you claim it yourself.
        </p>
        <h3>Why did my buy revert?</h3>
        <p>
          Usually slippage: the price moved past your limit before the trade landed. There are no
          buy caps and no blocked blocks. The copycat lock reverts a launch, not a buy.
        </p>
        <h3>Why was I charged more than 1%?</h3>
        <p>
          A direct launch has the creator&apos;s tax. A graduated pool has the 0.3% pool fee. A buy in
          the first three seconds after a launch pays the opening tax: 99% in the launch&apos;s own
          second, 6.18% in the next, 0.19% in the one after. The token page lists the creator&apos;s
          terms.
        </p>
        <h3>What do the team and open buyer labels mean?</h3>
        <p>
          <b>team</b> is a wallet that bought inside a Block Zero team launch, in the launch
          transaction itself. <b>open buyer</b> is a wallet the creator named at launch as paying
          no opening tax. Both lists are on the chain from the launch on, and the token page shows
          what each wallet holds now. See <a href="#team">team launches</a>.
        </p>
        <h3>Can the creator change the fees after launch?</h3>
        <p>No. Fees, taxes, allocations, exempt wallets and options are fixed at launch. Nobody can change them, including us.</p>
        <h3>Can anyone take money out of the Bag?</h3>
        <p>
          No. The Bag has no owner and no withdrawal function. It only pays its outlets by fixed
          rules. The house is paid by those rules like everyone else.
        </p>
        <h3>Where is the house coin?</h3>
        <p>
          It has not launched. The Vault and the burn clock wait for it. The Vault&apos;s share of every
          fee is held in the Bag and can be released once the coin exists. The burn clock keeps what
          it is paid until then. Nothing here promises it a date or a price.
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
              <tr><td><code>GET /tokens/:token/holders</code></td><td>The top 100 holders by balance. Each row says whether the wallet is a team wallet (<code>team</code>) or an open buyer (<code>exempt</code>).</td></tr>
              <tr><td><code>GET /tokens/:token/team</code></td><td>A team launch&apos;s wallets in the order they bought, with what each paid, got and still holds and when its lock opens, and the launch&apos;s open buyers (<code>exempt</code>).</td></tr>
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
              <tr><td>Factory</td><td><code>Launched</code>, <code>LaunchMetadata</code>, <code>FirstBuyLocked</code>, <code>LaunchExempt</code></td></tr>
              <tr><td>Curve (one per launch)</td><td><code>Bought</code>, <code>Sold</code>, <code>SoldOut</code>, <code>Graduated</code>, <code>Sniped</code>, <code>SnipeExempt</code>, <code>ProtocolClaimed</code></td></tr>
              <tr><td>Block zero</td><td><code>TeamLaunched</code>, <code>TeamLeg</code>, <code>TeamGas</code>, <code>FollowUp</code></td></tr>
              <tr><td>Fee router</td><td><code>Accrued</code>, <code>Flushed</code></td></tr>
              <tr><td>Portal</td><td><code>DirectLaunched</code>, <code>DirectMetadata</code>, <code>PoolOpened</code></td></tr>
              <tr><td>Launch hook (one per direct launch)</td><td><code>Taxed</code>, <code>Bonded</code>, <code>ClaimsFlushed</code>, <code>Sniped</code>, <code>SnipeExempt</code></td></tr>
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
          Robinhood Chain, chain id 4663. Deployed on 29 September 2026; the first receipt is in
          block 75134585. Launches made before that keep the rules of the contracts that printed them.
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
