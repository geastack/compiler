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
  runtime and geatsc plugin for compiling Node servers (`node:http`, Hono) to
  native executables. It is a dependency of this package: running `geatsc`
  with no input file inside a Node project builds each of the project's entry
  points through node-compat into `dist/`.

The Gea and Apple plugins are peer dependencies. Other plugins are loaded with
`--plugin`; see [docs/CLI-PLUGINS.md](docs/CLI-PLUGINS.md).

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes the pipeline, the
layering and the constraints. `CLAUDE.md` has the code conventions.

## Layering

```
identity/        canonical IDs
semantics/       target-neutral frontend: regions, structural types,
                 operations, edges, coverage
representation/  physical carriers, the sealed plan, fail-closed guards
conversion/      the closed dynamic-conversion capability algebra
preflight/       whole-pipeline capability census and certificate
ir/              typed IR: verified operations and SSA values
targets/cpp/     C++ emission; consumes typed IR only
diagnostics/     authority-component sweep, deterministic ordering
```

`semantics/` is the frontend/backend boundary. Nothing after it may import
`typescript` or touch a TypeScript AST.

## Constraints

1. **No source-shaped authority.** No decision may depend on a file name,
   path, source offset, `.pos`/`.end`/`getStart()` compared to a literal,
   source text, declaration or local spelling, statement layout, or generated
   C++ text. Identity is a checker symbol/declaration, a sealed semantic ID,
   or a versioned protocol identity.
2. **No boxing.** A value with a static type never gets the dynamic carrier.
   `Representation.dynamic` is allowed only for the four `DynamicReason`
   values declared in `src/representation/model.ts`.
3. **Fail closed.** When a guard fires, the defect is upstream. Do not relax a
   guard, downgrade an `unresolved`, or substitute a default for a missing
   fact. `unresolved` is lattice bottom, not an answer.

## Architecture gate

`scripts/architecture.mjs` checks `src/**/*.ts` for:

- file and directory size limits
- RegExp literals under `src/targets/cpp/`
- source-position literal comparisons
- `typescript` imports outside `src/semantics/`
- source-shaped discriminants
- unclassified `Authority`/`Admission`/`Proof` contracts
- class declarations under `src/targets/`
- `any`

It reports every violation in one run.

## Diagnostics

```bash
node dist/cli.js test/fixtures/spread.ts
```

Runs the full pipeline and prints every diagnostic. Exits non-zero when no
capability certificate was minted. `--preflight` prints the obligation census
as canonical NDJSON.

### Coverage

```bash
node dist/cli.js coverage app/index.ts --plugin ../node-compat/plugin/v2.mjs
```

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
unresolved and boxed carriers.

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
| `--entry-symbol <name>`                              | C++ function the program starts at. Default `__gea_top_level`, called by `core/gea_app_entry.cpp`.                                                                                                                                |
| `--dynamic-fallback`                                 | Allow boxed C++ runtime dispatch for supported dynamic features. No JavaScript engine is involved. See [docs/DYNAMIC-FALLBACK.md](docs/DYNAMIC-FALLBACK.md).                                                                      |
| `--isolate-symbols`                                  | Make every definition private to this program, for builds that link several programs into one binary. Programs that cannot be isolated are refused.                                                                               |
| `--translation-units single \| per-file \| balanced` | `single` (default): one C++ file. `per-file`: one file per source file, plus a shared `<stem>.hpp` and a program unit. `balanced`: per-file with small units grouped. See [docs/TRANSLATION-UNITS.md](docs/TRANSLATION-UNITS.md). |
| `--plugin <module>`                                  | Load a compiler plugin. Repeatable. See [docs/CLI-PLUGINS.md](docs/CLI-PLUGINS.md).                                                                                                                                               |
| `--plugin-option <lib.key>=<value>`                  | Passed unchanged to the library named by the prefix, e.g. `gea.cpp-prelude=...`.                                                                                                                                                  |

`compile-module-graph <gea-module-graph.json> --entry <file>` does the same
from vite's module graph instead of files on disk. Application builds use this
form. It takes the same options.

## npm scripts

| Script         | Purpose                                       |
| -------------- | --------------------------------------------- |
| `architecture` | Run the architecture gate                     |
| `typecheck`    | `tsc -p tsconfig.json --noEmit`               |
| `build`        | Architecture gate, then compile to `dist/`    |
| `format`       | `prettier --write .`                          |
| `format:check` | `prettier --check .`                          |
| `check`        | Architecture gate, typecheck and format check |

## License

The compiler and the runtime it links into generated programs are Apache-2.0
(see `LICENSE`). Programs you compile with geatsc are yours; their license
depends only on what they link. The GeaStack framework and the desktop, mobile
and web targets are also Apache-2.0. The embedded board support (`targets`,
`@geastack/chips`) is GPL-3.0-only; closed-source firmware needs a commercial
license. Contact [contact@geastack.com](mailto:contact@geastack.com) for
commercial terms.
