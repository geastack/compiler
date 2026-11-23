# geatsc

geatsc compiles TypeScript ahead of time to C++. The output contains no
JavaScript engine or interpreter. A C++ toolchain builds it into a native
binary for the target: ESP32 or RP2350 firmware, a macOS, iOS, Linux or Windows
app, an Xbox game, or a server executable.

The input is an ordinary TypeScript program, type-checked by the TypeScript
compiler. geatsc uses those types to pick native C++ representations: classes
become structs, numbers become native numeric types, and typed arrays, maps and
records become typed containers. This is what lets the same TypeScript run on a
microcontroller, and lets a compiled server use a fraction of the memory the
same code needs under Node.

## Where it fits in GeaStack

geatsc is the compiler for [GeaStack](https://github.com/geastack), a framework
for writing apps in TypeScript and JSX and running them natively on embedded
boards, desktop, mobile and consoles. The other repositories plug into it:

- [`core`](https://github.com/geastack/core) — the Gea framework (app API,
  reactivity, rendering engine, host services) and `geatsc-plugin-gea`, the
  plugin that teaches geatsc about Gea components and JSX.
- [`cli`](https://github.com/geastack/cli) — the `gea` command. `gea build`
  runs vite, and core's `build-gea-vite-geatsc.mjs` hands the module graph to
  `geatsc compile-module-graph`. The target's toolchain then builds the
  generated C++.
- [`targets`](https://github.com/geastack/targets),
  [`apple`](https://github.com/geastack/apple),
  [`linux`](https://github.com/geastack/linux),
  [`windows`](https://github.com/geastack/windows) — the platform projects that
  compile and link the generated C++. `apple` also ships a geatsc plugin for the
  Apple SDK bindings.
- Xbox — the Xbox target is not open source; it is available commercially.
  Contact [contact@geastack.com](mailto:contact@geastack.com).
- [`node-compat`](https://github.com/geastack/node-compat) — the Node.js
  runtime and geatsc plugin for compiling Node servers (`node:http`, HTTP frameworks) to
  native executables. It is a dependency of this package: running `geatsc`
  with no input file inside a Node project builds each of the project's entry
  points through node-compat into `dist/`.

The Gea and Apple plugins are peer dependencies. Other plugins are loaded with
`--plugin`; see [docs/CLI-PLUGINS.md](docs/CLI-PLUGINS.md).

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes the pipeline, the
layering and the constraints. `CLAUDE.md` has the code conventions.

## Installing

```bash
npm install -D @geastack/compiler
npx geatsc --help
```

The package installs the `geatsc` command. Generated programs are built with a
C++ toolchain you supply (clang++ by default for Node projects).

The examples below use `node dist/cli.js`, the same command run from a checkout
of this repository after `npm ci` and `npm run build`. With the published
package, write `npx geatsc` instead. `npm run build` also runs the post-build
checks against `dist/`, which take about six minutes on a 20-thread machine.
[docs/TESTING.md](docs/TESTING.md) covers the test suite.

## Layering

```
identity/        canonical IDs
semantics/       target-neutral frontend: regions, structural types,
                 operations, edges, coverage
plugins/         compiler plugin contract, loader and the built-in plugins
representation/  physical carriers, the sealed plan, fail-closed guards
projection/      physical calling conventions, binding cells, class layouts
conversion/      the closed dynamic-conversion capability algebra
preflight/       whole-pipeline capability census and certificate
ir/              typed IR: verified operations and SSA values
targets/cpp/     C++ emission; consumes typed IR only
diagnostics/     authority-component sweep, deterministic ordering
```

`semantics/` is the frontend/backend boundary. Outside `semantics/` and
`plugins/`, nothing may import `typescript` or touch a TypeScript AST.

## Constraints

1. **No source-shaped authority.** No decision may depend on a file name,
   path, source offset, `.pos`/`.end`/`getStart()` compared to a literal,
   source text, declaration or local spelling, statement layout, or generated
   C++ text. Identity is a checker symbol/declaration, a sealed semantic ID,
   or a versioned protocol identity.
2. **No boxing.** A value with a static type never gets the dynamic carrier.
   `Representation.dynamic` is allowed only for the `DynamicReason` values
   declared in `dynamicReasons` in `src/representation/model.ts`.
3. **Fail closed.** When a guard fires, the defect is upstream. Do not relax a
   guard, downgrade an `unresolved`, or substitute a default for a missing
   fact. `unresolved` is lattice bottom, not an answer.

## Architecture gate

`scripts/architecture.mjs` checks `src/**/*.ts` for:

- lines longer than 300 columns
- RegExp literals under `src/targets/cpp/`
- source-position literal comparisons
- `typescript` imports outside `src/semantics/` and `src/plugins/`
- source-shaped discriminants
- unclassified `Authority`/`Admission`/`Proof` contracts
- class declarations under `src/targets/`
- `any`
- diagnostic severity classified outside `diagnostics/sweep.ts`
- conversion calls that bypass the recipe dispatcher, and other single-owner
  rules it names in its summary line
- private copies of the compiler build beside `dist/`

It reports every violation in one run. `npm run architecture` also runs
`scripts/refusal-keys.mjs`, which checks that every refusal kind the C++
target can throw is a capability key.

## Diagnostics

```bash
node dist/cli.js test/fixtures/spread.ts --no-project
```

Runs the full pipeline and prints every diagnostic. Exits non-zero when no
capability certificate was minted. `--preflight` prints the obligation census
as canonical NDJSON.

Without `--no-project` or `--project`, a file is compiled under the nearest
`tsconfig.json`. For the fixtures in this repository that is the compiler's
own, which pulls the whole compiler source into the program and takes minutes
instead of seconds.

### Coverage

```bash
node dist/cli.js coverage app/index.ts --plugin node_modules/@geastack/node-compat/plugin/index.mjs
```

`coverage` loads `--plugin` as a file path relative to the working directory.
The example loads the Node.js plugin from `@geastack/node-compat`, which this
package installs as a dependency.

Prints one row per statement with a code, a status and a one-line reason,
followed by a summary and a count per code. Boxed carriers are reported as
rows too. Exits 0 only if a certificate was minted and nothing was refused
during lowering or emission.

| Code    | Layer                                                          |
| ------- | -------------------------------------------------------------- |
| `G1xxx` | TypeScript checker errors                                      |
| `G2xxx` | census blocker: a language primitive family the compiler lacks |
| `G3xxx` | representation guard violation                                 |
| `G4xxx` | preflight obligation missing/unsupported, by obligation kind   |
| `G5xxx` | IR lowering blocker                                            |
| `G6xxx` | emission refusal, by emitter category                          |
| `G7xxx` | calling-convention (ABI) projection blocker                    |
| `G8xxx` | boxed carrier (`gea::Value`), by reason                        |

The trailing digits index fixed tables in `src/cli-coverage.ts`, so rewording a
message does not change its code. `x999` means the table has no row for it.

Options: `--project`/`--no-project`, `--plugin`, `--plugin-option`, `--json`
(rows and summary as one object), `--no-derived` (roots only), `--no-boxed`
(refusals only).

### Carriers

```bash
node scripts/probe-carriers.mjs test/fixtures/language.ts
```

Prints the carrier and C++ spelling chosen for every declaration, and counts
unresolved and boxed carriers. Exits non-zero when either count is not zero.

## Emitting C++

```bash
node dist/cli.js compile app/index.ts --out-dir build/generated
```

The gea build pipeline runs this command (`build-gea-vite-geatsc.mjs` passes it
through `--geatsc-bin`). It writes to `--out-dir`:

- the generated C++
- `gea_runtime.h` and `generated_support.hpp`
- any files the installed hosts need beside the unit
- `geatsc-sources.txt`, the list of `.cpp` files to compile
- `geatsc-header.txt` (per-file layout only), the shared header to precompile

| Option                                               | Meaning                                                                                                                                                                                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--project <tsconfig.json>`                          | Project to compile the input under. Default: the nearest one. A `.js` bundle has none.                                                                                                                                            |
| `--entry-symbol <name>`                              | C++ function the program starts at. Default `__gea_top_level`, called by `packages/core/gea_app_entry.cpp` in the `core` repository.                                                                                              |
| `--dynamic-fallback`                                 | Allow boxed C++ runtime dispatch for supported dynamic features. No JavaScript engine is involved. See [docs/DYNAMIC-FALLBACK.md](docs/DYNAMIC-FALLBACK.md).                                                                      |
| `--isolate-symbols`                                  | Make every definition private to this program, for builds that link several programs into one binary. Programs that cannot be isolated are refused.                                                                               |
| `--translation-units single \| per-file \| balanced` | `single` (default): one C++ file. `per-file`: one file per source file, plus a shared `<stem>.hpp` and a program unit. `balanced`: per-file with small units grouped. See [docs/TRANSLATION-UNITS.md](docs/TRANSLATION-UNITS.md). |
| `--plugin <module>`                                  | Load a compiler plugin. Repeatable. See [docs/CLI-PLUGINS.md](docs/CLI-PLUGINS.md).                                                                                                                                               |
| `--plugin-option <lib.key>=<value>`                  | Passed unchanged to the library named by the prefix, e.g. `gea.cpp-prelude=...`.                                                                                                                                                  |

`compile-module-graph <gea-module-graph.json> --entry <file>` does the same
from vite's module graph instead of files on disk. Application builds use this
form. It takes the same options.

## npm scripts

| Script            | Purpose                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `architecture`    | Run the architecture gate and the refusal-key check                                                             |
| `typecheck`       | `tsc -p tsconfig.json --noEmit`                                                                                 |
| `build`           | Architecture gate, compile to `dist/`, mark the bins executable, then run the post-build checks against `dist/` |
| `gate`            | Emitted-set gate: emit the corpus and runtime programs and diff them against the tracked baselines              |
| `test`            | Build, then run the test suite (`test/run.mjs`)                                                                 |
| `test:release`    | Release-mode suite (`scripts/release-suite.mjs`)                                                                |
| `release:check`   | `check`, `build`, `gate` and `test:release`, in that order                                                      |
| `check:contracts` | Build, then run `test/contracts.mjs`                                                                            |
| `format`          | `prettier --write .`                                                                                            |
| `format:check`    | `prettier --check .`                                                                                            |
| `check`           | Architecture gate, typecheck and format check                                                                   |

## License

The compiler and the runtime it links into generated programs are Apache-2.0
(see `LICENSE`). Programs you compile with geatsc are yours; their license
depends only on what they link. The GeaStack framework and the desktop, mobile
and web targets are also Apache-2.0. The embedded board support (`targets`,
`@geastack/chips`) is GPL-3.0-only; closed-source firmware needs a commercial
license. Contact [contact@geastack.com](mailto:contact@geastack.com) for
commercial terms.
