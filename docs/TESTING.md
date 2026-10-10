# Tests from a fresh clone

Install the locked npm packages, then run the serial test suite:

```sh
npm ci --ignore-scripts
npm test
```

The build, compiled unit tests, standalone integrations, runtime fixtures, and
Node differential oracle run in separate processes. A failing command makes
`npm test` fail after the remaining commands have run. Existing TODO assertions
and optional external-corpus skips are reported by the individual tests.

Native tests require Clang with C++20 and sanitizer support. Framework headers
come from the declared npm development dependencies and their shipping source
manifest; no sibling core, Apple, or corpus checkout is required. The Node
project integration packs this compiler and installs that tarball into its test
application, so its native driver uses the compiler under test through normal
npm resolution. This integration needs access to the npm registry or cache.

`GEA_APPS_ROOT` and `GEA_NODE_COMPAT_ROOT` optionally enable additional tests of
external applications. They are not needed for the self-contained Node project
integration. The upstream Test262 dataset is a separate conformance sweep.

Correctness programs build at `-O0` against a runtime compiled once and linked
in; tests about allocation counts, optimizer assumptions or CPU shape keep their
optimized levels. `GEA_NATIVE_RELEASE=1 node test/run.mjs` builds every
correctness program at `-O2` with the runtime compiled into it, where
undefined-behaviour and aliasing defects surface. See
[NATIVE-BUILD-CACHE.md](NATIVE-BUILD-CACHE.md).

`npm run test:release` (`scripts/release-suite.mjs`) is the release gate. It runs
that release-mode suite with the real-app corpus cases enabled, and beside it every
suite this compiler ships against: each test and native example-app pipeline of
core's `run-tests.sh`, every example app's `test`, `test:native` and `check`, and
the `parallel` and `node-compat` package suites. `GEASTACK_ROOT` names the directory
holding the sibling checkouts; a missing checkout and any skipped test fail it.

The emitted-set comparison remains a separate check (`npm run gate`). Before any
release or publish, run `GEASTACK_ROOT=<dir> npm run release:check` (checks, build, gate,
release suite) on the build machine; a release does not go out until it passes. Pebble's
SDK-dependent size check is documented in [PEBBLE-SIZE.md](PEBBLE-SIZE.md).

## Inventory compiler regressions

Run `npm run test:inventory-regressions` against the current `dist/` compiler.
The focused runtime run uses the shipping single-translation-unit runtime path.
The focused invocation test checks that intrinsic refusals settle their guard
state while successful source calls do not. The compiler-owned reactive inventory
fixture is compiled, then its emitted record protocol is exercised natively:
reads expose typed values, writes notify once, incompatible reads refuse, and a
live-view signal reader follows the original owner and subsequent writes.
The runtime runner also checks getter-local dependency ownership with captured
list rows, and compares fractional `reduce`/`reduceRight` results with Node for
both primitive weights and item quantities. No IMS checkout or generated demo
artifact is required. The reactive protocol probe resolves the installed core package's
shipping `ui/signal.h` through the normal host include manifest; it deliberately exercises the real Signal implementation.
These fixtures participate in the ordinary runtime corpus as well.
