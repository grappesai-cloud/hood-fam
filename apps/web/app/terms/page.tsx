import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

/// Static, server rendered, no client code. The placeholders in "who we are" are the only things
/// an operator has to fill in; everything else describes what the software already does.

const LAST_CHANGED = "18 September 2026";

export const metadata: Metadata = {
  title: "terms · hood.fam",
  description: "The terms for using hood.fam, a launchpad on Robinhood Chain.",
  openGraph: {
    title: "terms · hood.fam",
    description: "The terms for using hood.fam, a launchpad on Robinhood Chain.",
    type: "website",
  },
};

export default function Terms() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <header className="page-intro">
        <div className="section-kicker">TERMS</div>
        <h1>terms of use</h1>
        <p>
          This text is a plain description of how the software works and what it does not promise.
          It is not legal advice, and the operator has to have a lawyer read it before it stands as
          the terms of anything.
        </p>
        <p className="mono mt-2 text-xs dim">last changed {LAST_CHANGED}</p>
      </header>

      <Section title="who we are">
        <p>
          hood.fam is operated by [OPERATOR LEGAL NAME], registered at [REGISTERED ADDRESS],
          reachable at [CONTACT EMAIL], under the law of [JURISDICTION]. Disputes about these terms
          go there.
        </p>
      </Section>

      <Section title="what hood.fam is">
        <p>
          hood.fam is software for launching and trading tokens on Robinhood Chain, chain id 4663.
          It shows you what is on that chain and it builds transactions your wallet can sign. It is
          not a broker, not an exchange, not a bank and not a custodian. Using this site means you
          accept these terms; if you do not, do not use it.
        </p>
      </Section>

      <Section title="your wallet, your transactions">
        <p>
          hood.fam is non custodial. It never holds your tokens, never holds your keys and cannot
          move anything for you. Every transaction is signed by your own wallet, sent to the chain
          by you, and irreversible once it lands. Nobody here can reverse it, cancel it, refund it
          or recover funds sent to a wrong address. Keeping your keys and your device safe is your
          job, and a transaction signed by your wallet counts as yours.
        </p>
      </Section>

      <Section title="tokens are made by other people">
        <p>
          Anyone can launch a token here. The tokens are created by third parties, not by us. We do
          not endorse them, vet them, audit them, price them or check anything their creator says
          about them. A name, a ticker, a picture and a link on a token page are what the creator
          typed. Most launches go to zero. Check the token address yourself, and treat every claim
          around a token as the creator&apos;s claim, not ours.
        </p>
      </Section>

      <Section title="fees">
        <p>
          Fees are charged on chain by the contracts, in the amounts and splits the project
          documentation describes. They are taken inside the transaction you sign, so what you pay
          is settled by the contracts and not by this site. The contracts are the source of truth if
          a number here and a number on chain ever disagree.
        </p>
      </Section>

      <Section title="the season drop">
        <p>
          The season pool is discretionary. It is a slice of revenue the protocol already earned,
          set aside by the treasury for a season, and it can be different in the next one or not
          happen at all. Points are a score, not a claim, not a security and not a balance owed to
          you. Nothing is promised, nothing is guaranteed and nothing is minted for you. What the
          pool is worth and how it splits is described on <Link href="/airdrop">the drop</Link>.
        </p>
      </Section>

      <Section title="no warranty">
        <p>
          The site is provided as is, with no warranty of any kind. We do not promise it will be
          available, correct, uninterrupted or free of defects. Indexed data can lag the chain, be
          wrong or be missing. Prices, charts, balances and points on this site are informational
          and the chain is authoritative.
        </p>
      </Section>

      <Section title="no liability for losses">
        <p>
          To the fullest extent the law allows, we are not liable for any loss you take from using
          this site or the contracts behind it. That includes lost funds, failed or reverted
          transactions, slippage, gas, a token going to zero, a rug by a creator, a bug, downtime,
          a wrong number on a page, or anything a third party does.
        </p>
      </Section>

      <Section title="not financial advice">
        <p>
          Nothing on this site is financial, investment, tax or legal advice, and nothing here is a
          recommendation to buy or sell anything. Trading tokens is risky and you can lose
          everything you put in. Decisions you make with your own wallet are your own.
        </p>
      </Section>

      <Section title="where you can use it">
        <p>
          Access may be restricted where the law requires it. You may not use the site if you are in
          a place, or are a person, that the applicable law bars from it, and we may block access
          from anywhere for legal reasons without notice. Do not use the site to break the law, to
          launder money, to manipulate a market or to impersonate somebody.
        </p>
      </Section>

      <Section title="these terms can change">
        <p>
          We can change these terms. The date at the top is the date of the last change, and using
          the site after that date is accepting the version that is up. If a part of these terms
          cannot be enforced, the rest still stands.
        </p>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel space-y-2 p-4">
      <h2 className="font-semibold">{title}</h2>
      <div className="space-y-2 text-sm leading-relaxed dim [&_a]:text-[var(--color-lime)] [&_a]:underline">
        {children}
      </div>
    </section>
  );
}
