# geatsc — Agent Operating Rules

`geastack/CLAUDE.md` one level up applies in full. This file adds what is
specific to the compiler. `AGENTS.md` is a symlink to this file.

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before changing anything: the
pipeline, the layering, and the three absolute constraints every change answers
to.

## Use the native stack

The native stack is working, measured, shipped code, and the compiler rewrite
replaced none of it: the engine in `core/`, the platform targets, the host
bridges **and their generators**, and the shim tables the feature packages ship
as data.

This is a compiler, not a new runtime, host layer or app shell. **Never
hand-roll a substitute for something the stack already ships.** Drive the real
thing; if the compiler cannot plug into it, the deliverable is the smallest
adapter plus a fix on the compiler side, never a parallel implementation. Where
two generators exist for one artifact, use the one the shipping product uses.

Every substitute so far has been worse _and_ proved less, because it hides the
real compiler gap behind a shim and the defect never gets fixed.

## One compiler

**`dist/` is the compiler. There is exactly one, every change rebuilds it, and
every measurement is taken against it.**

Never build a private copy — not a `dist-<label>` beside it, not a second
`outDir` in a scratch tsconfig, not a snapshot copied so a gate is isolatable.
A number from a private build is a number for a compiler nobody else has and
nobody can reproduce, which is indistinguishable from an unverifiable claim.

The reasoning for a private copy always sounds good: two builds made minutes
apart are not comparable while the tree moves. That is a real problem and this
is the wrong answer to it — serialize with whoever else is editing instead.

Enforced rather than trusted: `scripts/architecture.mjs` fails on any directory
holding a `compiler.js` beside a `representation/` that is not `dist/`, detecting
by content rather than name, and `scripts/corpus.mjs` throws if `GEA_CORPUS_DIST`
is set.

## The emitted-set gate

```bash
npm run gate
```

**Run it after any change under `src/targets/` or `src/semantics/`, before you
believe a fix works and long before the runtime suite.**

It emits the C++ for the corpus and runtime programs, hashes each after
normalizing SSA numbering, and diffs against the tracked baselines
(`scripts/emitted-baseline-corpus.txt`, `scripts/emitted-baseline-runtime.txt`).
It names every program your change moved.

It is the only thing that answers _did my change move output for programs I was
not thinking about_:

| check                               | what it proves                       |
| ----------------------------------- | ------------------------------------ |
| `npx tsc -p tsconfig.json --noEmit` | the compiler builds                  |
| `node scripts/architecture.mjs`     | the source obeys its rules           |
| `npm run gate`                      | **which programs your edit changed** |
| `scripts/run-runtime-tests.mjs`     | programs still behave, slowly        |

A diff is exactly one of two things and you must say which:

1. **The change you are making.** Then the commit names these programs and says
   why they should move, and re-takes the baselines with `npm run gate -- --write`
   **in that same commit**.
2. **A regression.** You just found it cheaply, with a name.

A refactor that only re-homes a decision must move **nothing**. Byte-identical is
the pass condition, not close enough.

One authority is not isolation: collapsing duplicated decisions gives each
decision _more_ consumers, so changing a shared authority moves every consumer at
once. Fixes are not independent, and this gate is how you see that.

The gate attributes a diff to the tree, not to you. While several sessions are
editing, say the moved set is unattributed and do **not** re-take the baselines —
a baseline taken over someone else's uncommitted work does not match a fresh
checkout of your commit. Runs are safe to overlap mechanically: each emits into
its own pid-suffixed directory under `measurements/`.

If you cannot rebuild `dist/`, you cannot take this gate, and you must say so:
"unverified — could not rebuild, gate not taken." Do not describe a reasoned
change as a tested one.

## Safety

This is a git repo, so git is the safety net — and the root `CLAUDE.md` git rules
apply in full: never switch branches, never destroy uncommitted work. Git is the
only snapshot mechanism; do not keep a parallel one in a directory.

## Code conventions

- Prettier: `printWidth: 140`, no semicolons, single quotes, no trailing commas.
  Run `npx prettier --write` on files you create.
- TypeScript is strict, plus `exactOptionalPropertyTypes` and
  `noUncheckedIndexedAccess`; `noUnusedLocals`/`noUnusedParameters` are on.
- ESM with `NodeNext`: **relative imports must end in `.js`**. Prefer `type`
  imports for types.
- Modules of exported functions plus factory-created state. No classes as
  namespaces, no inheritance ladders, no singleton module state. Classes are for
  re-instantiated data structures, fixed-point engines, and `Error` subclasses.
- `scripts/architecture.mjs` is the authority on every mechanical limit — read it
  rather than trusting a number in a document. It deliberately has no per-file
  line cap and no per-directory file cap; those were size limits, not
  architecture, and all they produced was files split at arbitrary boundaries.
- Every family producer takes the one `ProducerContext` from
  `src/semantics/normalize/producer-context.ts`. Do not define a second: the two
  counters it carries are shared on purpose, and a producer holding its own would
  hand two different operations the same identity as soon as two families
  published for one caller.
- Comment the _why_, not the _what_. A comment earns its place by explaining a
  decision a reader would otherwise reverse-engineer. Do not narrate the code, do
  not label sections, do not restate a signature in prose.
- `npx tsc -p tsconfig.json --noEmit` must be clean before reporting done. Run
  vitest one file at a time, never a whole-suite batch.
