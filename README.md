# geatsc

The geastack TypeScript-to-C++ compiler.

It is a clean-room rewrite. The design goal is the second constraint below: a
statically typed value that reaches a dynamic carrier is a defect. The earlier
implementation could not be driven to zero of them, because boxing was
load-bearing in its emitter and removing it anywhere broke it somewhere else.
Starting from a tree where the carrier algebra is closed and fail-closed from
the first commit is what makes "no boxing" a property rather than an aspiration.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the pipeline, the layering
and the constraints, and `CLAUDE.md` for the code conventions.

## Layering

```
identity/        canonical IDs
semantics/       the target-neutral frontend: regions, structural types,
                 operations, edges, coverage. The frontend/backend boundary.
representation/  physical carriers, the sealed plan, and fail-closed guards
conversion/      the closed dynamic-conversion capability algebra
preflight/       whole-pipeline capability census and certificate
ir/              typed IR: verified operations and SSA values
targets/cpp/     emission; consumes typed IR only
diagnostics/     authority-component sweep, deterministic ordering
```

Nothing after `semantics/` may import `typescript` or touch a TypeScript AST.
That boundary is what stops two layers from answering the same question
differently.

## Absolute constraints

1. **No source-shaped authority.** No decision may depend on a file name,
   path, source offset, `.pos`/`.end`/`getStart()` compared to a literal,
   source text, declaration or local spelling, statement layout, or generated
   C++ text. Identity is a checker symbol/declaration, a sealed semantic ID,
   or a versioned protocol identity.
2. **No boxing.** A value with a static type never gets the dynamic carrier.
   `Representation.dynamic` is admissible only for the four declared
   `DynamicReason` values in `src/representation/model.ts`.
3. **Fail closed.** A guard firing is always correct; the defect is upstream.
   Never relax a guard, never downgrade an `unresolved`, never default when a
   fact is missing. `unresolved` is lattice bottom, not an answer.

## Architecture gate

`scripts/architecture.mjs` enforces the layering over `src/**/*.ts`: file and
directory size maximums, and zero-tolerance checks for RegExp literals under
`src/targets/cpp/`, source-position literal comparisons, `typescript` imports
outside `src/semantics/`, source-shaped discriminants, unclassified
`Authority`/`Admission`/`Proof` contracts, class declarations under
`src/targets/`, and `any`. It collects every violation before failing, so one
run reports everything wrong rather than one thing at a time.

## Looking at what it does

```bash
node dist/cli.js test/fixtures/spread.ts
```

runs the whole pipeline and prints the complete diagnostic set — never a top-N —
exiting non-zero when no capability certificate was minted. Add `--preflight` for
the full obligation census as canonical NDJSON.

```bash
node dist/cli.js coverage app/index.ts --plugin ../node-compat/plugin/v2.mjs
```

answers the porting question the diagnostics do not: **which lines of my file
are the problem, and what kind of problem is each?** It joins every layer's
outcome by source position and prints one row per statement with a stable
code, a status and a one-line reason, then a summary and a by-code count. A
carrier that BOXED is a row too -- the program compiles and runs slower than it
says, and no other view places that on a line. Exit 0 iff a certificate was
minted and nothing refused at lowering or emission.

| Code    | Layer                                                          |
| ------- | -------------------------------------------------------------- |
| `G1xxx` | the TypeScript checker's own errors                            |
| `G2xxx` | census blocker: a language primitive family the compiler lacks |
| `G3xxx` | representation guard violation                                 |
| `G4xxx` | preflight obligation missing/unsupported, by obligation kind   |
| `G5xxx` | IR lowering blocker                                            |
| `G6xxx` | emission refusal, by the emitter's category                    |
| `G7xxx` | calling-convention (ABI) projection blocker                    |
| `G8xxx` | boxed carrier (`gea::Value`), by reason                        |

The trailing digits index fixed tables in `src/cli-coverage.ts`, never a hash
of a message, so rewording a diagnostic keeps its code; `x999` means the table
lacks a row. Options: `--project`/`--no-project`, `--plugin`, `--plugin-option`,
`--json` (rows + summary as one object), `--no-derived` (roots only),
`--no-boxed` (refusals only).

```bash
node scripts/probe-carriers.mjs test/fixtures/language.ts
```

prints the carrier and C++ spelling selected for every declaration, and counts
unresolved and boxed carriers. It is the view of the structural mapper and
carrier selection, which nothing else exercises directly.

## Emitting C++

```bash
node dist/cli.js compile app/index.ts --out-dir build/generated
```

is the command the gea build pipeline drives (`build-gea-vite-geatsc.mjs`
passes it through `--geatsc-bin`). It writes the C++ into `--out-dir` together
with `gea_runtime.h`, `generated_support.hpp`, whatever the installed hosts
require beside the unit, `geatsc-sources.txt` -- the list of `.cpp` files the
build compiles -- and, for the per-file layout, `geatsc-header.txt` naming the
shared header the build should precompile. Options:

| Option                                               | Meaning                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--project <tsconfig.json>`                          | The project the input compiles under. Default: the nearest one; a `.js` bundle has none.                                                                                                                                                                                                                |
| `--entry-symbol <name>`                              | The C++ function the target starts the program at. Default `__gea_top_level`, which `core/gea_app_entry.cpp` calls.                                                                                                                                                                                     |
| `--dynamic-fallback`                                 | Opt in to boxed C++ runtime dispatch for supported dynamic features. No JavaScript engine. See [coverage and limits](docs/DYNAMIC-FALLBACK.md).                                                                                                                                                         |
| `--isolate-symbols`                                  | This program is one of several a resident build links: everything it defines is private to it, and a program that cannot be isolated is refused.                                                                                                                                                        |
| `--translation-units single \| per-file \| balanced` | How many C++ files the program becomes. `single` (default) is one unit. `per-file` is one unit per source file plus a shared `<stem>.hpp` and a program unit, for parallel and incremental C++ builds. `balanced` groups the small units. See [`docs/TRANSLATION-UNITS.md`](docs/TRANSLATION-UNITS.md). |
| `--plugin <module>`                                  | Load an external compiler plugin; repeat for multiple plugins. See [CLI plugins](docs/CLI-PLUGINS.md) for exports, compatibility and precedence.                                                                                                                                                        |
| `--plugin-option <lib.key>=<value>`                  | Delivered verbatim to the library whose prefix names it (`gea.cpp-prelude=...`).                                                                                                                                                                                                                        |

`compile-module-graph <gea-module-graph.json> --entry <file>` is the same
command over vite's module graph instead of files on disk, and is the path every
real application build takes; it accepts the same options.

## npm scripts

| Script         | Purpose                                                   |
| -------------- | --------------------------------------------------------- |
| `architecture` | Run the architecture gate.                                |
| `typecheck`    | `tsc -p tsconfig.json --noEmit`.                          |
| `build`        | Run the architecture gate, then compile to `dist/`.       |
| `format`       | `prettier --write .`.                                     |
| `format:check` | `prettier --check .`.                                     |
| `check`        | Architecture gate, typecheck, and format check, in order. |

## License

Apache-2.0 (see `LICENSE`), the compiler and the runtime it combines into
generated programs alike. Programs you compile with geatsc are yours; their
license is decided only by what they link. The GeaStack framework and the
desktop, mobile and web targets are Apache-2.0 as well; the embedded board
support (`targets`, `@geastack/chips`) is GPL-3.0-only and needs a commercial
license for closed-source firmware. Contact [contact@geastack.com](mailto:contact@geastack.com) for commercial terms.
