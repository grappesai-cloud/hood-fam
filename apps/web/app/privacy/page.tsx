import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

/// Static, server rendered, no client code. Everything below describes what the code in this
/// repository actually does: the indexer reads the public chain, the support assistant opens a
/// ticket, the API rate limits by IP, and the browser keeps two things in sessionStorage.

const LAST_CHANGED = "18 September 2026";

export const metadata: Metadata = {
  title: "privacy · hood.fam",
  description: "What hood.fam collects, who it goes to, and how to have a support ticket deleted.",
  openGraph: {
    title: "privacy · hood.fam",
    description: "What hood.fam collects, who it goes to, and how to have a support ticket deleted.",
    type: "website",
  },
};

export default function Privacy() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <header className="page-intro">
        <div className="section-kicker">PRIVACY</div>
        <h1>privacy</h1>
        <p>
          This text is a plain description of what the software collects and where it goes. It is
          not legal advice, and the operator has to have a lawyer read it before it stands as a
          privacy policy.
        </p>
        <p className="mono mt-2 text-xs dim">last changed {LAST_CHANGED}</p>
      </header>

      <Section title="who we are">
        <p>
          hood.fam is operated by [OPERATOR LEGAL NAME], registered at [REGISTERED ADDRESS], and the
          address for anything on this page, including a deletion request, is [PRIVACY CONTACT
          EMAIL], under the law of [JURISDICTION].
        </p>
      </Section>

      <Section title="there is no account">
        <p>
          There is nothing to sign up for. We store no accounts, no usernames, no passwords, no
          email address unless you hand one over in a support ticket. Connecting a wallet does not
          create an account with us; it lets the page read an address and lets your wallet sign.
        </p>
        <p>
          A wallet address and everything it has ever done are public data on the chain, published
          by the chain and not by us. Anybody with a block explorer can read them. We cannot make
          chain data private and we cannot delete it.
        </p>
      </Section>

      <Section title="what is actually collected">
        <p>
          <strong>Chain data.</strong> Our indexer reads Robinhood Chain and keeps the launches,
          trades, holders, stakes and the addresses in them, so the site can show a board, a chart
          and a leaderboard without a third party in the data path. All of it was already public on
          the chain before we read it.
        </p>
        <p>
          <strong>Support tickets.</strong> If you open one, we keep the contact you typed (an
          email, a Telegram handle or an X handle), the subject, the message and the summary of the
          conversation, the page you were on, and your wallet address if the page had one. That is
          the only place you hand us anything about yourself.
        </p>
        <p>
          <strong>Server logs.</strong> The API logs requests with the IP address they came from, so
          it can rate limit and deal with abuse. Nothing on this site joins a log line to a wallet
          or to a ticket.
        </p>
        <p>
          <strong>Browser storage.</strong> Two things are kept by your browser, for the tab you are
          in and nowhere else: a support chat draft, so a reload does not lose what you were
          typing, and an admin token if you are an operator signing in to the admin screens. Both
          live in session storage, which your browser clears when the tab closes. They never reach
          us as stored data.
        </p>
      </Section>

      <Section title="who it goes to">
        <p>
          <strong>The model provider.</strong> When the support assistant is switched on, what you
          type to it and the context of your conversation go to Anthropic, which runs the model that
          answers. That is the only reason your message leaves our servers, and it does not happen
          at all when the assistant is off; the ticket form works on its own either way.
        </p>
        <p>
          <strong>Nobody else.</strong> There is no advertising on this site, no analytics tracker,
          no pixel, no third party session recorder and no data sale. We do not build a profile of
          you and we do not share what you send us with anyone except where the law forces us to.
        </p>
      </Section>

      <Section title="how long a ticket is kept">
        <p>
          A ticket stays in our database until somebody deletes it. Nothing removes it on a timer
          today, because a ticket is a conversation a person still has to answer. Closing a ticket
          marks it closed; it does not erase it.
        </p>
      </Section>

      <Section title="having a ticket deleted">
        <p>
          Ask, and it is deleted. Write to the address in <em>who we are</em> from the contact you
          used on the ticket, or open a new ticket from the help button and say which one to remove.
          We delete the contact, the message and the transcript. What we cannot delete is anything
          on the chain, because we did not put it there and it is not ours to remove.
        </p>
        <p>
          The terms that go with this page are at <Link href="/terms">terms</Link>.
        </p>
      </Section>

      <Section title="this page can change">
        <p>
          If what the software collects changes, this page changes with it. The date at the top is
          the date of the last change.
        </p>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel space-y-2 p-4">
      <h2 className="font-semibold">{title}</h2>
      <div className="space-y-2 text-sm leading-relaxed dim [&_a]:text-[var(--color-lime)] [&_a]:underline [&_strong]:text-[var(--color-text)]">
        {children}
      </div>
    </section>
  );
}
