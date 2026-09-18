#!/usr/bin/env python3
"""Mutation testing for the money-critical contracts.

For each mutation in mutants.json: apply it, run the fast test suite, and record whether the suite
FAILS (the mutant is "killed" -- a test caught the bug) or PASSES (the mutant "survived" -- a gap in
the tests). A survivor is not a bug in the contract; it is a bug in the tests, and it is exactly what
this is for. Files are restored from git after every run, so nothing is left mutated.

    python3 scripts/mutation/run.py

Add a mutation by adding a {file, find, replace, why} entry to mutants.json. `find` must be a string
that appears exactly once in the file (the script replaces the first occurrence).
"""
import json
import os
import subprocess

ROOT = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
os.chdir(ROOT)
HERE = os.path.dirname(os.path.abspath(__file__))
muts = json.load(open(os.path.join(HERE, "mutants.json")))

results = []
for m in muts:
    f = m["file"]
    src = open(f).read()
    if m["find"] not in src:
        results.append((m["id"], "SKIP-notfound", m["why"]))
        print(f"{'SKIP':9} {m['id']:26} (find string not present)")
        continue
    open(f, "w").write(src.replace(m["find"], m["replace"], 1))
    try:
        r = subprocess.run(
            ["forge", "test", "--no-match-path", "test/Fork*.t.sol", "-q"],
            capture_output=True, text=True, timeout=900,
        )
        killed = r.returncode != 0  # a killed mutant makes the suite fail to compile or fail a test
        tag = "KILLED" if killed else "SURVIVED"
    finally:
        subprocess.run(["git", "checkout", "--", f], capture_output=True)
    results.append((m["id"], tag, m["why"]))
    print(f"{tag:9} {m['id']:26} {m['why']}")

killed = sum(1 for r in results if r[1] == "KILLED")
surv = [r for r in results if r[1] == "SURVIVED"]
print("\n=== SUMMARY ===")
print(f"{killed} killed, {len(surv)} survived, {sum(1 for r in results if r[1].startswith('SKIP'))} skipped")
for r in surv:
    print("  SURVIVOR (test gap):", r[0], "-", r[2])
raise SystemExit(1 if surv else 0)
