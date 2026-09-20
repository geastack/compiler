# Translation units

How many C++ files a program becomes.

```sh
geatsc compile app.ts --out-dir build/generated --translation-units per-file
```

The option takes `single`, `per-file` or `balanced`, on both `compile` and
`compile-module-graph`; the API equivalent is
`CompilationRequest.translationUnits`. `single` is the default.

## Why the layout is a choice

A C++ compiler works on one translation unit at a time. A program in one unit
compiles on one core and recompiles whole after any edit. A program in many
units compiles on every core at once and recompiles only the units whose text
changed.

That is the whole case for splitting, and it is a case about the build rather
than about the program: the emitted program is the same set of functions either
way. `src/targets/cpp/translation-unit.ts` renders all three, and they are the
same function up to the last step — every index, census, struct, signature,
thunk, construction and body is computed once, and only the placement differs.

What splitting costs is linkage. A function another unit may call, or take the
address of, has to be visible across units, so the layouts differ in how much
they can keep internal.

## The three layouts

| Layout     | What it produces                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `single`   | One unit. The default, and what the build consumed before the others existed.                                                                           |
| `per-file` | One unit per module, plus the declaration and runtime headers and the program unit. Maximum build parallelism, maximum cross-unit linkage.              |
| `balanced` | Per-file, then module units of at most 16 KiB are grouped into deterministic batches bounded by 64 KiB and 16 modules. Large modules stay on their own. |

`balanced` exists because per-file on a program of many small modules spends
more time starting compiler processes than compiling. Its grouping uses fixed
filename hash buckets, so editing one module does not repack unrelated groups
and the warm cache survives.

## The sources list

Whichever layout is used, `geatsc-sources.txt` in the output directory lists
every `.cpp` the build should compile, and for the per-file layouts
`geatsc-header.txt` names the shared header worth precompiling. A build driver
should read those two files rather than globbing the output directory.
