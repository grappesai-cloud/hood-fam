"use client";

/// The reasons the number on the left can move without anybody doing anything wrong. They matter,
/// so they stay on the page; they are not what somebody came to read, so they stay closed. Five
/// bullets of prose sitting open under a calculator is how a page stops being read at all.
const LINES = [
  "Nothing here is owed to you. The pool is money the protocol already earned.",
  "The treasury sets the cut per season. The next one can differ.",
  "Your share falls when other wallets earn, so it drops while you do nothing.",
  "Rank is rolling thirty day volume. Stop trading and it falls.",
  "This is arithmetic on today's pool, not a forecast and not advice.",
];

export function WhatThisIsNot() {
  return (
    <details className="panel fineprint">
      <summary>What this is not</summary>
      <ul>{LINES.map((line) => <li key={line}>{line}</li>)}</ul>
    </details>
  );
}
