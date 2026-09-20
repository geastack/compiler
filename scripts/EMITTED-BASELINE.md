# The emitted-set gate baseline

`emitted-baseline-corpus.txt` and `emitted-baseline-runtime.txt` are the
normalized hash of every program the two emitted sets produce, at the commit
that last moved them.

They are TRACKED on purpose. Every gate baseline before them lived only under
the gitignored `measurements/`, and one was lost outright when a stray
`rm -rf measurements` ran -- which cost the ability to say whether a landing had
changed the emitted set at all. A baseline that can be deleted without a trace
is not a baseline.

## Taking the gate

```bash
npm run gate
```

That is the whole thing. It exits non-zero and names every program whose output
moved. **Run it after any change under `src/targets/` or `src/semantics/`.**

It is one command because the recipe below — which is what this file used to
open with, and which is still what `npm run gate` does — was skipped on
2026-09-07 by a session that then shipped seven regressions the gate would have
named in a single run. An instrument only ever gets skipped for being
inconvenient, so the inconvenience was removed.

`npm run gate -- --write` re-takes both baselines. Do that **only** in the same
commit that legitimately moves the set, and name the moved programs in the
message.

<details><summary>What it runs, for when you need to do it by hand</summary>

```
export TMPDIR=$PWD/measurements
node scripts/emit-corpus.mjs measurements/emitted-next
node scripts/emit-corpus.mjs measurements/emitted-next-rt --runtime
for d in emitted-next emitted-next-rt; do
  ( cd measurements/$d && for f in *; do printf '%s %s\n' "$f" "$(node ../../scripts/normalize-emitted.mjs "$f" | shasum | cut -c1-12)"; done ) | sort > measurements/$d.hashes.txt
done
diff scripts/emitted-baseline-corpus.txt measurements/emitted-next.hashes.txt
diff scripts/emitted-baseline-runtime.txt measurements/emitted-next-rt.hashes.txt
```

</details>

A refactor that re-homes a decision must produce no diff at all. A diff is
either the change being measured -- in which case the commit says so, names the
programs, and says why they are the ones that should move -- or a regression.
`printer-drift.txt`, `drift.txt` and `uncertified.txt` are reports rather than
programs; they move when the set gains a program.

Update these two files in the same commit that legitimately moves the set, never
separately.
