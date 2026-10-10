# Native test builds

Every program the suites link and run is built by `buildNative` in
`scripts/native-build-cache.mjs`. Two decisions shape that build, and each has
one authority, `scripts/native-optimization.mjs`.

## Optimization level

A level is chosen by what a program is there to prove, never written at the call
site. Tests ask for `nativeOptimization(purpose)`:

| purpose       | level | for                                                                  |
| ------------- | ----- | -------------------------------------------------------------------- |
| `correctness` | `-O0` | the program's output or assertions; every runtime and oracle program |
| `allocation`  | `-O1` | allocation-count and emitted-shape probes, taken at `-O1`            |
| `optimized`   | `-O2` | what the optimizer may assume (signed zero, NaN, aliasing)           |
| `aggressive`  | `-O3` | CPU proofs                                                           |
| `size`        | `-Os` | code-size probes                                                     |

`-O0` because it is where clang spends least: on a sample of runtime programs
against the prebuilt runtime, a unit took 0.3-0.7 s at `-O0` and 3.9-5.0 s at
`-O1`.

`GEA_NATIVE_RELEASE=1` is the release gate. Every `correctness` build goes to
`-O2` with the runtime compiled into the program, which is how a shipping
program is built; undefined-behaviour and aliasing defects can surface only
there. Run it before a release, not on every edit.

## How a program reaches the runtime

`gea_runtime.h` is header-only: tens of thousands of lines of inline functions
and templates. `buildNative({ runtime })` chooses how a program gets their code.

- **`prebuilt`** (the default for correctness builds). The runtime PCH is built
  with `-fpch-codegen -fpch-instantiate-templates`, and the object compiled from
  that PCH carries every inline function and every template instantiation the
  header makes, once. A unit including the PCH references those rather than
  emitting its own copy, and the program links the object. Clang does the split,
  so it is ODR-safe by construction and needs no change to the header.
- **`single`**. The runtime is compiled into the program's own translation
  unit. Benchmarks, device builds (`@geastack/node-compat`'s build driver and
  the board tooling, which never use this builder) and the release gate need
  it: the optimizer inlines the runtime into a program only when it sees both.

`prebuilt` is used only when every unit of the program takes the PCH. A unit
that reaches the runtime through a prelude of its own (host declarations or
macros before `#include "gea_runtime.h"`) may see a different ABI, and its copies
would be merged with the object's by the linker, so `run-emitted.mjs` builds
such a program `single`. `--runtime prebuilt|single` on `run-emitted.mjs` and
`run-runtime-tests.mjs` overrides the default.

## The shared runtime cache

The PCH and the runtime object live in `measurements/native-runtime/` (override
with `GEA_NATIVE_RUNTIME_CACHE`), shared by every worker, every harness and
every suite run. The key is the compiler and its version, the flags, the
include path with the output directory abstracted away, the layout, and the
content of every header the runtime reaches -- so editing any of them builds a
new entry, and restoring an old header reuses the old one.

The headers beside the runtime are copied into the entry and the PCH is built
from those copies: a PCH records the path of each input, and must not depend on
whichever worker built it first. The runtime header therefore needs a macro
include guard, not `#pragma once`, which is per path.

Builders publish with a rename into a directory of their own, so a concurrent or
crashed builder can never leave a half-written artifact in use. A lock keeps the
workers that start together from building the same entry more than once.
Entries untouched for a day are pruned.

The first build of a key costs about 15 s (PCH plus runtime object); after
that, a typical runtime program compiles in 0.3-0.7 s and links in about 0.15 s,
against about 3 s per program when every program compiled the runtime itself.

## Object caching

`node scripts/run-runtime-tests.mjs --only <name> --timings` reports each
program's PCH state, runtime layout and phase times. ccache is used for program
objects when it is on `PATH`.

Two opt-outs, for taking a control measurement:

| Flag                | Effect                                                       |
| ------------------- | ------------------------------------------------------------ |
| `--no-native-cache` | disables object caching, the PCH and the prebuilt runtime    |
| `--no-pch`          | keeps object caching, drops the PCH and the prebuilt runtime |

## Checking the cache

```bash
node test/native-build-cache.mjs --out-dir measurements/cxx
```

builds repeatedly and asserts the cache behaves: a transitive header change
invalidates what it should, two output directories share one artifact, both
runtime layouts build the same program, a failed build is never published, and
cached and uncached builds of the same program produce identical output.
