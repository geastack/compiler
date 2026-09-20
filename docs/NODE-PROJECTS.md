# Building a Node project

With geatsc installed on PATH, run `geatsc` in a Node project. No entry argument,
module mappings, library source list, or Node plugin flag is required.

The command finds the nearest package.json, installs missing dependencies with
the project's package manager and lockfile, discovers the executable entry,
and invokes the existing native Node target. It writes each executable directly
under `dist/`. Generated C++ and the machine-readable report live under
`dist/.geatsc/<executable-name>/`, isolated when a package declares multiple
`bin` entries. The generated code includes runtime headers from the installed
compiler package; it does not copy them into the project. It compiles but does
not launch the app.

Entry discovery uses a literal `scripts.start` command, `bin`, package exports/main,
then an unambiguous conventional index/main/server entry. Declared build outputs
can resolve to their TypeScript inputs through package/build metadata. Launch
scripts are inspected, never executed to find an entry. An ambiguous project or
an entry requiring an unsupported launch convention receives a diagnostic.

`geatsc --dynamic-fallback` enables the existing C++ dynamic fallback.
`--debug` and `--emit-only` are also available. The raw C++ linker command is
hidden by default and available with `--verbose`. The default single translation
unit is `<executable-name>.cpp`; `--translation-units per-file` emits a program
unit and one module unit for each TypeScript source file. Release builds do not
emit debug symbols; `--debug` enables them. Explicit-file compilation,
`compile`, `analyze`, and `coverage` retain their existing interfaces.

## Dependencies and sources

Module lookup uses the shared compiler resolver, including package exports and
imports, import/require conditions, nested dependency versions, and tsconfig
path aliases. The Node target enables the `node` condition. User path mappings
retain their original base directory; generated native builtin paths are absolute.
The generated project retains only target module mappings actually imported by
the resolved source graph, so a project that imports no Node builtin has no
target-generated `paths` entries.

For source discovery the compiler reads:

- Explicit source export conditions and the package's source/main/module metadata.
- TypeScript rootDir/outDir mappings, including an inferred common input root.
- Literal Rollup input/output declarations, including literal output moves.
- Literal esbuild outbase/outdir declarations in metadata-named build scripts.
- Available single-source JavaScript source maps.

This inspection does not execute build configurations or plugins. Published
exports still control which subpaths are accessible; source discovery does not
turn a private subpath into a public one.

Generated dependencies missing their typed source inputs can be fetched
from the repository and full commit recorded in the installed version's npm
metadata. Both registry identity and checkout package identity must match.
There is no latest-branch or tag-guess fallback. Checkouts are cached under
`node_modules/.cache/geatsc/sources`, and imports from them use the original
installed package's dependency search path. Different installed versions remain
separate. Packages already shipping authored JavaScript remain usable as JavaScript.
Unavailable pinned source metadata or a failed checkout is reported and retains
the installed implementation.

Missing dependencies use npm, pnpm, or Yarn. Installs disable lifecycle scripts;
locked installs use the manager's frozen/immutable mode. A build requiring an
install script, an unavailable package-manager executable, Yarn PnP resolution,
or an arbitrary custom launcher is not yet handled by this initial workflow.
It does not install system tools: Node, the selected package manager, Git when a
checkout is needed, and a compatible C++ toolchain must be available.

The compiler declares `@geastack/node-compat` as an npm dependency and resolves
its exported build driver through npm. The target package contains the existing
plugin and native runtime. No sibling checkout or copied target tree is required
by application builds. The compiler ships its own C++ headers. Apple SDK and
Apple/Gea plugin packages are optional peers, so a Node installation does not
pull in platform SDKs. In the development workspace, npm-style package links
point to the existing repositories.

## Corpus integration

`corpus/scripts/case.mjs` no longer implements `selfSourcePaths` or writes a
paths.json mapping guessed source filenames. It provides the fetched package
root to the shared Node driver. The compiler owns the mapping from published
module targets to source. The Node oracle uses that same resolver and executes
the selected TypeScript source with Node, so an unbuilt checkout does not
silently resolve to another installed package version.

The corpus's existing repository-fetch stage still owns fetching tests and
its version/provenance ledger. That stage is separate from the compiler's
version-pinned dependency source cache.

## Validation and limits

Run these separately after `npm run build`:

```
node --test test/node-project.mjs
node --test test/module-resolution.mjs
node test/dynamic-fallback.mjs
npm run typecheck
```

Project tests include no-argument native compile/link/run through the npm
Node target dependency, project aliases under NodeNext, unbuilt real Zod, neverthrow,
tiny-invariant, Hono, and MongoDB checkouts, exact-version source acquisition
and cache reuse, nested dependency identity, and the Node source oracle.

Automatic project preparation is not universal JavaScript/Node compatibility.
The compiler still refuses unsupported semantics and host APIs. The tiny-invariant
corpus slice resolves its implementation without overrides but remains blocked
by the target's missing global process binding and a tagged-union array allocation
in the test. Fastify still has the runtime/compiler blockers documented in
No native Fastify benchmark is claimed.
