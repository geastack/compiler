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
  ├─ ir/shake.ts                 whole-program reachability from the entry
  ├─ ir/publish-conversion-recipes.ts   finalized operation, spread and loop recipes
  ├─ ir/program-conversions.ts   generated entry, initializer and adapter recipes
  ├─ ir/certify.ts               every capability the IR demands, as one key namespace
  ├─ ir/certificate.ts           minted from a refusal-free walk over the lowered IR
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

Internal operation conversions, structural view leaves, callable adapters and
dense-loop loads are published before IR certification. The certificate covers
the exact conversion nodes and their dependencies. Printers consume those
citations; a rejected node cannot fall through to another conversion renderer.
The architecture check permits no raw conversion calls outside the central
recipe dispatcher.

Live-arm merge reconstructions publish each selected arm and optional absence
conversion after SSA homes are finalized. A truthiness rebuild additionally
requires the exact authenticated `&&` split and its `ToBoolean` capability;
an ordinary value conversion or a different logical operation cannot borrow
that proof. Certification recomputes the plan before the renderer consumes
its canonical citations. The dispatcher's module exemption does not extend
to IR operation renderers or their nested callbacks.

Object spread plans name each field, index and sidecar store. A creation-order
walk is admitted as a complete frame; its static fallback is selected before
certification. Iterator and iterable views likewise cite receiver, yield,
completion, thrown-value and nested cursor recipes. Deferred callbacks require
the complete dependency closure to run without a prior control-flow proof;
partial conversions must perform their own authenticated runtime check.

A method read preserves the Function object without capturing its original
receiver. An explicit `call` supplies the logical receiver, an explicit `bind`
retains it, and a detached call supplies `undefined`. Native references preserve
`undefined` separately from `null`; structural views retain their authenticated
native origin without boxing the class object. Callable adapters forward this
receiver protocol alongside their certified argument and result conversions.

Erased native calls and binds share the
[logical receiver inventory](../src/representation/native-logical-receiver.ts)
with their renderer. A carrier without a retained receiver payload is admitted
only when every possible source body independently ignores `this`. A public
receiverless ABI alone does not prove that. Exact physical receiver frames and
authenticated host templates use their own call entries; unsupported erased
entries refuse during certification rather than inventing a runtime TypeError.

[Call rendering](../src/projection/callee.ts) selects a template from the exact
member protocol and its overrides. Array elements, dictionary entries, Proxy
reads and own Function fields retain their callable frames. Host method rows
can defer a template, while host Function properties carry their declared ABI
and explicit receiver behavior. A mixed builtin call admits only native
template arms or positively proven noncallable alternatives; an unknown arm
cannot borrow another arm's proof.

## Native structural fields

A shared structural view retains the original allocation and live field
descriptors. Creating the view does not invoke getters or snapshot values.
Reads and writes publish receipts for the actual SSA receiver, source storage
carriers and exact conversion leaves. Certification reconstructs those receipts
from the final operations. A public interface's field type cannot substitute
for an allocation's physical storage. Closed generic copies use their own
instantiated field types; an unfilled type parameter from another template
cannot nominate a storage carrier.

Fixed-key selection requires a complete proof for every possible key. The
renderer evaluates the receiver and key before the right-hand side, then
selects the existing native descriptor route. Getter invocation retains its
effects and abrupt completion. A getter body with a void physical result can
publish undefined only through its authenticated public value carrier. Native
reference comparison follows allocation identity across views.

The native data-definition receipt names the actual descriptor argument,
destination fields and payload conversion. Runtime definitions consume the
typed payload from `NativeDescriptorData`; reading the descriptor's separate
boxed observation slot would silently replace it with undefined. Optional
field hooks apply attributes and SameValue checks to their native storage too.
Definitions through a live view require a descriptor delegation proof, rather
than a definition on the view's placeholder fields.

An identity-keyed sidecar capability alone does not prove that a new typed key
is declared-any storage. Typed extension keys need source-owned storage and
writer proofs, even when their current values are primitive. Dynamic accessor
observation likewise prevents a structural recipe from claiming unused field
reflection. Sealing replaces provisional contracts and independently publishes
Function identity and native argument/result transport; these are distinct
facts.

## Mutable dictionary views

An open declared-any Document can expose a fixed shared native record through
the [document field plan](../src/conversion/document-record-view.ts). Allocation
retains the immediate Document and its original native owner; it does not
sample fields, migrate storage, or invoke accessors. Each later field operation
cites its checked reader or total entry writer. The declared-any entry boundary
belongs only to that installed Document route. An ordinary typed field or
extension cannot borrow it. Every normal arm of a composite view must preserve
native payload or live identity; one copying arm prevents the whole identity
claim. Index-bearing and accessor target schemas remain refused until their
complete storage protocols are selected.

Changing a dictionary's value carrier must preserve the same mutable object.
An entry-by-entry copy loses identity and later writes through aliases. A
narrowing also needs an authenticated check on every read; knowing that one
call omits an optional argument does not prove its future result's entries.
String- and number-keyed shared dictionaries now retain their native source
through a live entry view. Each reader cites a complete checked recipe and
each mutable writer must be total into the source storage. Descriptors,
deletion, key order, identity and source tracing belong to that same allocation;
key-only enumeration never validates entry values. A genuine dynamic boundary
observes the original broad entries while typed reads retain their checks.

A wider carrier whose legal writes cannot fit the source storage needs the
contextual `readOnlyDictionaryFor` recipe and a closed SSA-use proof, independently
recomputed by certification. The runtime view exposes no writer. Escaping
aliases and open consumers are refused. Ownership alone does not prove unique
storage, and owned or symbol-keyed entry views remain unsupported.

The following fixtures exposed views previously emitted as copies:

| Fixture                                                                                                                 | Required storage relationship                                                       |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Generic index result](../test/runtime/generic-copy-closes-conditional-inside-an-index-signature.runtime.ts)            | Persistent numeric `any` table returned as a table of `Key` instances.              |
| [Numeric typed result](../test/runtime/numeric-keyed-any-table-into-typed-numeric-table.runtime.ts)                     | Numeric `any` table returned as the same table of `Id` instances.                   |
| [Empty literal and assertions](../test/runtime/instanceof-over-union-with-record-arm-after-an-empty-literal.runtime.ts) | String-or-array table written and returned through a string-table assertion.        |
| [Header merge](../test/runtime/merge-arm-dictionary-into-header-union.ts)                                               | Caller-owned string table widened into the header union under an optional wrapper.  |
| [Asserted callback result](../test/runtime/asserted-arrow-drops-optional-parameter-and-narrows-result.runtime.ts)       | Native table alternatives retained in a callback result and selected by exact tags. |

The old recast is present in the earliest available repository commit,
`a51b954c7` (2026-09-20); earlier origin history is unavailable. Its comment
explicitly accepted losing source mutations. Its narrowing emitted unchecked
entry `get<0>()` reads. The asserted-callback fixture added in `d5e9da41c`
(2026-10-02) returns fresh all-string entries, which masks both defects.
[Dictionary view tests](../src/conversion/dictionary-view.test.ts) require exact
checked readers and total writers; [read-only proof tests](../src/ir/read-only-dictionary.test.ts)
reject mutable or escaping uses of contextual readers. Exact native identity
and injection into native sums need no view.

Another initial-commit rule grouped homogeneous dictionary union arms into a
single dictionary with union-valued entries, without an allocation or alias
proof. `Record<string,string> | Record<string,string[]>` must retain two native
table alternatives; it is not `Record<string,string | string[]>`. The grouping
made the asserted callback's narrow return need a wider mutable table and
erased the exact arm its result adapter could select. Normalization now keeps
those arms, with only exact carrier duplicates collapsed during derivation.
[Normalization regressions](../src/semantics/normalize/structural-joins.test.ts)
pin this distinction and exact optional subset selection.

A fresh allocation can need mixed entries even when its stated type is a union
of homogeneous tables. The source-keyed
[fresh storage census](../src/semantics/normalize/fresh-dictionary-storage.ts)
uses the shared value-flow inventory to close that allocation under its actual
aliases, writes and complete callable frames. It publishes one physical entry
carrier for that component, including its parameter and result channels, while
leaving the checker type and unrelated table allocations unchanged. Unknown
inputs, escaping consumers and incomplete frames invalidate the whole component;
an assertion cannot supply either an allocation proof or an entry value type.
Completion channels include expression-bodied arrows, and each returned call
result must have an accounted consumer. Constructor arguments use authenticated
source forwarding frames even when ordinary call-target discovery is empty.
The shared complete-frame authority still refuses bodies that observe their
`arguments` object; this census does not invent a weaker caller inventory.
Native dictionary storage also retains its source for tracing, even when its
typed entries are primitive: a live view may own a broader source containing
references.

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

## Independent worker and worklet programs

The host build compiles each worker/worklet module graph as its own translation
unit and entry symbol. `--realm-storage` (the API's `realmStorage: true`) makes
module bindings, class statics, CommonJS caches, symbol literals and tagged
template caches native realm slots. It does not run a worker entry during main
module initialization. This is an explicit build decision, consumed by the same
binding-placement map throughout rendering; ordinary programs keep their existing
static storage.

The host enables `GEA_RUNTIME_REALMS=1` consistently for all translation units
and binds `gea::detail::RuntimeRealmScope` for the complete worker task lifetime,
including its callbacks and promise jobs. The default root realm survives the
embedded startup-task to frame-task handoff. `GEA_RUNTIME_SINGLE_THREADED` alone
is not sufficient for worker isolation. The realm owns runtime sidecars, promise
queues, allocation pools and cycle-collector state. On termination the host must
close event sources and release native callback captures on their owning task
before clearing the realm. Realm teardown releases globals, collects remaining
cycles, and finally destroys collector/allocator state.

`gea::Ref` handles must remain in their originating realm. Structured clone
copies primitive/native byte storage and constructs receiver-local wrappers;
ArrayBuffer transfer detaches sender views and moves its owned bytes. This is
not a boxed-value boundary. Host module registries store only native entry
functions, and do not retain compiled closure objects across realms.

`node test/worker-realms.mjs` checks concurrent promise/global isolation, root
task handoff, cleanup of mutual reference cycles and emitted module/class-static
isolation with address and undefined-behavior sanitizers.
