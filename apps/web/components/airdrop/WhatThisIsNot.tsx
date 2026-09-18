"use client";

/// The other half of an honest calculator: the reasons the number on the left can move without
/// anybody doing anything wrong.
const LINES = [
  "Nothing here is owed to you. The pool is money the protocol already earned, not a token it promised.",
  "The cut of that take is set by the treasury for each season and can be different in the next one.",
  "Your share falls when other wallets earn points, so the number drops while you do nothing.",
  "Rank is rolling thirty day volume. Stop trading and it drops, and everything you earn drops with it.",
  "The estimate is arithmetic on today's pool at today's prices. It is not a forecast and it is not advice.",
];

export function WhatThisIsNot() {
  return (
    <section className="panel space-y-2 p-4">
      <h2 className="font-semibold">what this is not</h2>
      <ul className="space-y-1.5 text-xs dim">
        {LINES.map((line) => (
          <li key={line} className="flex gap-2">
            <span className="text-[var(--color-lime)]">·</span>
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
