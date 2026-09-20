# Architecture

geatsc compiles TypeScript ahead of time to C++. There is no interpreter and no
JavaScript engine in the output: the binary is the program.

This describes the shape of the compiler — the stages a program passes through,
which layer owns which question, and the constraints the whole design answers
to. `src/compiler.ts` runs the stages in exactly this order and is the authority
on them.

## The pipeline

```
rootFileNames
  │
  ├─ plugins/installed.ts     instantiate the plugins for this build
  ├─ semantics/frontend.ts    ts.Program + checker — the only file access
  │    ├─ normalize/identities.ts   NodeId / DeclarationId / FunctionId
  │    ├─ normalize/structural.ts   ts.Type → StructuralShape, interned
  │    ├─ normalize/flow/           one whole-program value-flow index
  │    ├─ normalize/census.ts       every syntactic site → an operation family
  │    ├─ normalize/producers/      the family producers
  │    └─ normalize/normalize.ts    → SemanticGraph                    SEALED
  │
  ╌╌╌╌ no TypeScript AST past this line ╌╌╌╌
  │
  ├─ representation/derive.ts    StructuralShape → Representation
  ├─ representation/publish.ts   per-component transaction → the sealed plan
  ├─ representation/verify.ts    the fail-closed guards
  ├─ conversion/build.ts         Representation → per-carrier ConversionGraph
  ├─ conversion/derive.ts        the dynamic-conversion capability algebra
  ├─ targets/cpp/manifest.ts     what the backend can actually spell
  ├─ preflight/run.ts            the plan's census: carriers, call paths, native boundaries
  ├─ diagnostics/sweep.ts        one ordered report from every layer
  ├─ projection/abi.ts           each function's physical calling convention
  ├─ projection/bindings.ts      where each binding cell physically lives
  ├─ projection/classes.ts       what each class is made of
  ├─ ir/lower.ts                 typed IR: SSA over the object substrate
  ├─ ir/certify.ts               every capability the IR demands, as one key namespace
  ├─ ir/certificate.ts           minted from a refusal-free walk over the lowered IR
  ├─ ir/shake.ts                 whole-program reachability from the entry
  └─ targets/cpp/translation-unit.ts   emission, gated on the certificate
```

Two properties of this order matter more than the order itself.

**The frontend boundary is real.** Nothing after `semantics/` imports
`typescript` or touches a TypeScript AST. That is what stops two layers from
answering the same question differently, and it is enforced mechanically rather
than by convention.

**Certification covers the lowered IR, not a prediction of it.** The certificate
is minted from a walk over operations that exist, so emission runs only for a
program whose every demand the backend has already said it can spell. A
capability the backend cannot spell is a refusal with a name, not a surprise at
print time.

## Layering

```
identity/        canonical IDs
semantics/       the target-neutral frontend: regions, structural types,
                 operations, edges, coverage
representation/  physical carriers, the sealed plan, and the fail-closed guards
conversion/      the closed dynamic-conversion capability algebra
preflight/       whole-pipeline capability census
ir/              typed IR: verified operations and SSA values
targets/cpp/     emission; consumes typed IR only
diagnostics/     authority-component sweep, deterministic ordering
```

One question has exactly one authority. Where a question could be answered in
two places, the answer belongs to whichever layer owns it, and the other layer
consumes the published fact rather than recomputing it. The target is a printer:
it consumes facts and spells them, and computes none of its own.

## Absolute constraints

1. **No source-shaped authority.** No decision may depend on a file name, a
   path, a source offset, source text, a declaration's spelling, or generated
   C++ text. Identity is a checker symbol, a sealed semantic ID, or a versioned
   protocol identity.

2. **No boxing.** A value with a static type never gets the dynamic carrier.
   The dynamic representation is admissible only for the declared reasons in
   `src/representation/model.ts`. Opting in to
   [dynamic fallback](DYNAMIC-FALLBACK.md) widens what a program may use, and
   even then execution stays in generated C++.

3. **Fail closed.** A guard firing is always correct; the defect is upstream.
   A guard is never relaxed, an unresolved answer is never downgraded, and a
   missing fact never defaults. `unresolved` is the bottom of the lattice, not
   an answer.

`scripts/architecture.mjs` enforces the mechanical half of this over `src/**`:
the layering imports, the absence of `typescript` outside the frontend, and the
rest. It collects every violation before failing, so one run reports everything
wrong rather than one thing at a time.

## The plugin seam

Plugins extend the compiler from inside normalization and lowering rather than
beside them. `src/plugins/model.ts` is the extension point: a `producers` hook
can replace a core family producer for programs that use it, a `lower` hook runs
before the core's own IR lowering, and a plugin's `capabilities` merge into the
target manifest that certification looks demands up in.

An empty plugin list is a supported configuration: a program that names no
library the compiler does not already know is unaffected by any plugin. See
[CLI plugins](CLI-PLUGINS.md) for how to write and load one.

## Seeing what it does

```bash
node dist/cli.js test/fixtures/spread.ts
```

runs the whole pipeline and prints the complete diagnostic set — never a top-N —
exiting non-zero when no certificate was minted.

```bash
node dist/cli.js coverage app/index.ts
```

answers the porting question the diagnostics do not: which lines of a file are
the problem, and what kind of problem each one is. It joins every layer's
outcome by source position and prints one row per statement with a stable code.
The code tables are in the repository README.
