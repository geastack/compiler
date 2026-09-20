# Automatic implementation resolution

Ordinary imports now load executable package implementations without a
per-package source map supplied by the caller. JavaScript admission is enabled
by default. `javaScriptSources: true` remains accepted for existing callers;
`dynamicFallback` independently controls dynamic representation and runtime support.

`src/semantics/module-resolution.ts` asks TypeScript's resolver two questions,
with separate caches scoped to the compilation:

- Type lookup uses the original host and package metadata.
- Implementation lookup hides declaration files and type-only package metadata.
  The same resolver still owns runtime export conditions, `imports`, self
  references, subpath patterns, exclusions, nested dependency versions, and
  project aliases. Import and require edges carry their own resolution modes.

This follows TypeScript's distinction between runtime lookup and declaration
substitution, described in its [module reference](https://www.typescriptlang.org/docs/handbook/modules/reference).
The compiler uses the public resolution API and a filtered filesystem view,
not an internal compiler option or a second implementation of Node's resolver.
It does not execute package code during discovery.

Explicit bundler module targets and virtual source overlays remain authoritative.
An automatically selected JavaScript file with an adjacent single-source map
can resolve to the available original TypeScript source. Missing sources,
remote source URLs and multi-source bundles retain the JavaScript implementation.
The Node project workflow can also acquire version-pinned repository sources.
Package/build metadata supplies source mappings; callers need no per-library
`src/index.ts` guesses. See [Node projects](NODE-PROJECTS.md).

The complete type-declaration lookup is retained separately from the declaration
eligible for an implementation overlay. Same-package contracts are passed to
the existing conservative declaration-to-JSDoc overlay; its existing mirrored
DefinitelyTyped support remains available without substituting declaration classes
for implementation classes. That overlay preserves
annotations already written in the source and still declines signatures it
cannot transfer safely. This is not a complete merger of arbitrary declaration
files into JavaScript bodies. Explicit type-only imports retain declarations;
declaration dependencies remain in the type graph.

An installed plugin can register `declarationModules`, a set of exact module
specifiers and `package/*` claims whose implementation is native. The Apple
plugin registers its SDK package explicitly. An explicit declaration target in
a caller-supplied module graph is also authoritative. Sharing a package directory
with JavaScript is no longer evidence of a native binding.

A value import with declarations but no implementation or native registration
gets diagnostic 95001. Pure type imports are exempt. Unsupported runtime
operations continue to fail the existing compiler guards.

The old Three-specific aliases were removed from `scripts/corpus.mjs`.
The standalone npm corpus and node-compat use the shared compiler through their
existing build driver, so they receive this resolver without a second package
loader. The standalone corpus supplies a fetched package root to the driver; its
previous `selfSourcePaths` guesses and generated paths.json overrides are removed.
The compiler resolves unbuilt checkouts through the same source-discovery engine.

## Validation

Run `npm run build`, then `node --test test/module-resolution.mjs`.
The tests exercise package layouts in memory, native compilation and execution,
and the installed Fastify, Hono, MongoDB, BSON and Three packages. Installed-package
tests require this workspace's application dependencies; missing dependencies
fail visibly. Loading a real library's source graph is tested separately from
native compilation. It is not recorded as an end-to-end library pass.

The Fastify application with the Node plugin now loads 189 JavaScript files;
the previous application probe loaded zero. Its full compilation remains blocked
on CommonJS/runtime and representation gaps; see `Fastify status` (archived).

The existing WebGL type-realization test currently fails linking with
`Undefined symbols: "_Map"`. The same emitted external Map reference reproduces
in a minimal TypeScript program with no imports. The new Apple resolution test
checks native registration and certification, but does not conceal that separate
link failure.
