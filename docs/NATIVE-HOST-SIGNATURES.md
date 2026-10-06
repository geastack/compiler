# Native host signature inspection

A TypeScript `number` declaration does not say whether a native callback
supplies an integer. Native host bindings can now provide the declaration
identity and the headers that contain their implementation signature. The
compiler asks Clang to resolve that signature before integer analysis runs.

The host supplies locations and linkage spellings, not a duplicate list of
callback types. `NativeHostFunctionDeclaration` contains:

- The exact TypeScript declaration file and declaration name.
- The native C++ function spelling.
- Header paths, optional include directories, and optional Clang arguments.

The frontend authenticates the complete checker symbol declaration set.
Application shadowing or an unauthorized merged declaration does not inherit
the host's integer facts. Referenced authenticated functions are inspected;
unreferenced functions do not launch Clang.

Clang's JSON type graph resolves aliases, `std::function`, and function pointer
signatures. Integer widths and signedness come from Clang-evaluated expressions
under the inspection flags. Only integer ranges exactly representable as
JavaScript numbers can seed ordinary `number` parameters. Floating values,
data pointers, unsupported types, and wider integer ranges do not gain integer
facts. Ambiguous overloads and declaration/signature mismatches fail closed.

The emitted unit asserts both the inspected integer properties and the complete
resolved native function signature. The target C++ compiler therefore rejects a
different integer width or a macro-selected change in the callback signature,
rather than compiling incorrectly narrowed code.

Integer analysis accounts each authenticated callback argument separately. Its
native writes join ordinary program calls. A fractional write or an unknown
escape still prevents narrowing. Self-rescheduling callbacks can retain their
native input facts; merely passing another callback to the same host does not
authenticate that argument.

Integer propagation runs to its shrinking fixed point. Bound propagation allows
for the program's dependency depth and refuses unstable cycles independently,
then recomputes surviving bounds from zero. An unrelated numeric cycle cannot
erase a proven native timestamp, and a temporarily stable downstream bound
cannot survive after its input proof was rejected.

The Gea binding currently enables inspection for `requestAnimationFrame`, using
the real `@geastack/host/include/host/timers.h`. The build passes its actual core
and host roots, and the app uses the framework's declaration. Clang must be
available when a program references an inspected binding.

Native facts narrow generated callback bodies and propagate integer facts into
their callees. Explicit integer types also retain their width during structural
normalization and representation selection. The scalar remains a language Number,
but its representation records `integerWidth`; representation and callable ABI
keys include that width. Integer callback parameters and results therefore use
integer calling conventions, including types originating in declaration files.
Ordinary Number callbacks retain their double convention.

The storage census still excludes declaration files because ambient declarations
allocate no executable binding cells. It now reads contextual binding types too.
The integer type contract is established separately, before brand reduction, so
the storage census is no longer responsible for an ambient callable's signature.

Numeric entry conversions use the existing `toDeclaredInteger` truncate-and-wrap
helper. Dynamic Number assertions first check the Number tag and then perform
the same conversion. Mixed-width numeric comparisons normalize through the slot
census; the emitter's mixed-carrier guard stays intact. Native range proofs remain
available through an explicit 64-bit integer callback parameter, so preserving
the callable convention does not reintroduce paired downstream tick bodies.

Native numeric storage conversions also compose through optional and union
carriers. An `int32` or `int64` field assigned to a CSS `number | string |
undefined` property enters its numeric arm after the ordinary integer-to-Number
conversion. The sum planner and scalar conversion chain share
`conversion/number-storage.ts`; both render through `emit-number-storage.ts`.
Exact arm identity takes precedence, multiple non-exact numeric homes are
rejected, and every source alternative, including null and undefined, must
retain a destination. These conversions allocate no box and use no field
protocol. A numeric cast does not claim identity-preserving payload transport.

`native-selection.test.ts` covers both integer widths, nested optional unions,
single evaluation, and ambiguous homes. `declared-integer-contracts.mjs` also
executes CSS field assignments, absence propagation, and Number-to-int32 union
stores under ASan/UBSan.

## Automatic integer cloning removed

Commit `d5e9da41c` (October 2, 2026), the MongoDB driver CPU campaign, added a
second rendering of eligible Number-taking functions. The source comment names
BSON's dynamically supplied `options.index` as its motivation: a runtime integer
test could authorize integer arithmetic where static input proof was unavailable.
The original Number body remained for fractional and other noninteger inputs.

The policy applied to the entire program, not just MongoDB. Its profitability
rule was `premised.values.size - original.values.size >= 8`: eight additional
IR values eligible for integer storage justified copying the whole body. It had
no generated-byte budget, hot-path evidence, or measured-speedup requirement.
Changes in integer analysis could therefore change which unrelated application
and library functions crossed that threshold.

The original regression fixtures required the dispatch guard and exercised
integer, fractional, and negative-zero behavior. They checked that cloning
worked, not that its cost was justified. They had no output-size assertion;
the emitted-set gate detects changed output but supplies no profitability
criterion. That is why correctness checks did not prevent the expansion.

Read-only inspection of Skytail's retained Mosaico build on October 6 found 91
unique generated integer copies and 90 retained `_integral` code symbols totaling
175,156 bytes. The largest copy was 22,530 bytes. The binary was 8,669,712 bytes,
modified at 17:52:56 local time. No earlier 6.4 MB ELF was available in the
inspected build tree. These counts establish direct duplicate-code cost; they
do not establish the cause of the entire reported roughly 1.9 MB increase or
the indirect size contribution of dependencies pulled in by those copies.

The automatic cloning policy, runtime dispatch, and second body emission have
been removed entirely. Explicit integer contracts and proven integer inputs
still narrow a single implementation. Unproved Number inputs keep one general
implementation. The original fractional-input and negative-zero fixtures now
require absence of the speculative guard and integer copy while retaining their
behavioral expectations. Integer-case performance of formerly cloned functions
has not been remeasured; no speedup is claimed from this removal.

## Async task cloning replaced with one convention

The same October 2 MongoDB commit also introduced `_task` twins. Eligible
suspending async functions were rendered twice: the regular Promise body and
the same statements returning `gea::Task<V>`. An immediate, single-use await
selected the twin at compile time to avoid a Promise state. The commit reports
roughly 2–6% per-operation CPU improvement, explicitly described as noisy;
it does not establish a code-size budget. Behavioral ordering checks did not
reject the duplication because both paths preserved the same microtask order.

The duplicate body emission and per-call selection were removed. The replacement
is a whole-program convention proof in `src/ir/async-result-conventions.ts`:

- A closed, capture-free local function with a plain payload may use Task when
  every surviving call is direct, immediately awaited by a coroutine, and has
  exactly one result use. There must be one physical body and exact payload
  returns. Unknown/multiple-use results reject the entire function.
- A function value passed, returned, converted, captured, or stored outside its
  unique local binding keeps Promise. Region/export cells, methods, generic
  dispatch, capturing closures, non-suspending async functions, and adopting
  returns conservatively keep Promise until their boundaries are proved.
- The selected convention controls the original body signature and all of its
  call-result storage. The body is rendered once under its original symbol;
  there is no `_task` copy and no run-time convention check.
- The existing callable carrier still has a Promise ABI. Its small thunk
  forwards to the single Task body using `co_await`; it does not repeat the
  function's statements. The proof excludes indirect calls, so proved direct
  awaits bypass this compatibility thunk. Removing the unused callable carrier
  itself is a separate possible optimization, not a correctness prerequisite.

Task avoids a separate Promise state at the admitted calls. Its result remains
in the coroutine frame until consumed, so this is not a universal memory
reduction. No application speedup or byte savings are claimed without a new
measurement. Mixed-use functions retain Promise even at their immediate awaits;
that trades the old optimization at those calls for a single implementation.

The previous removal passed six focused async execution fixtures, but its
standard build was interrupted under extreme machine load. Its emitted-set gate
reported changes across the shared uncommitted tree, and its runtime-header
checksum changed during testing. Those historical checks do not validate this
replacement. Current validation (October 6):

- Architecture and TypeScript checks pass. Canonical `dist/` was rebuilt from
  the latest sources before the final emitted-set gate and execution checks.
- All five new execution fixtures pass: immediate numeric/void results, thrown
  errors before and after suspension, finally cleanup, synchronous completion,
  microtask order, loop reuse, retained results, function escapes, and conservative
  fallbacks for captures, recursion, adopting returns and synchronous callers.
  Six existing async regression fixtures also pass: **11 execution fixtures**.
- The compiler plus runtime fingerprint matched before the final run and
  after ten fixtures: **2,064 files**, SHA256
  `df45203d905817ab29a40f7d912cf4ca38b7b4d901a917d6fc8b4594fee567ca`.
  The last fixture also passed, but the post-run checksum changed to
  `390d6aca10bbeac9aaace442030fda8332946ceacd370b58d9174caf8547a0ad`.
  The source runtime header changed again at 22:50:33; canonical emitter files
  retained their rebuild timestamps. These are successful execution checks on
  the tested snapshots, not an unchanged-workspace verification claim.
- The standard `npm run build` completed successfully, including all 12 native
  ASan/UBSan integer-contract cases. However, `emit.ts`, `emit-tostring.ts` and
  the runtime header changed during that longer run. Its full-check pass belongs
  to the earlier build snapshot; the final rebuild and focused execution checks
  above exercise the rebuilt compiler. Subsequent runtime-header changes and
  the entire current suite are not claimed as verified.
- The final emitted-set gate remains **red** for the shared uncommitted tree:
  **79 corpus outputs moved, 1,034 runtime outputs moved, 16 runtime additions,
  no losses**, 76 printer refusals and zero certified IR drift. Its runtime set
  contains 1,194 rows. These totals cannot be attributed solely to this change.
  Existing baselines were left unchanged.

The initial positive fixture caught use of `cppTypeOf(void)` when spelling
`Task<void>`. This was corrected to the existing result-type authority,
`cppResultTypeOf`, which admits void results; no guard was relaxed.

## Historical RAF conversion: root cause

The earlier production M5 build invoked the callback through
`int -> double -> long long`. This is a compiler representation gap, not a
fractional timestamp supplied by the native host.

1. At the time of that production build the framework declaration was
   `(timestampMs: number) => void` (`core/packages/core/index.d.ts`). It now
   declares `int`, the framework's existing 64-bit integer alias. The scalar
   compatibility check accepts declared integers only when the native integer
   range fits; floating inputs and oversized integer inputs are rejected.
   That declaration change alone did not specialize the callable ABI: the
   previous representation still collapsed its branded Number to the general
   numeric carrier. `cppScalarType` in
   `src/targets/cpp/types.ts` maps the general `number` domain to `double`;
   `cppAbiType` renders the callable's declared parameter representations.
2. Native signature inspection authenticates `std::function<void(int)>`.
   Those facts enter the integer-storage census, which proves the callback
   body and downstream tick parameters integer. They do not rewrite the
   callable representation's `CallableAbi`.
3. `formalsOf` in `src/targets/cpp/translation-unit.ts` explicitly applies
   narrowing only to implementation bodies. `thunkOf` calls `formalsOf(abi)`
   without narrowing and casts its double parameter to the narrowed body's
   `long long`. Callable storage remains `gea::CallableObject<void(double)>`.
4. C++ accepts that object as the target of `std::function<void(int)>` because
   its `operator()(double)` is callable with an integer. The standard-library
   invocation wrapper converts that integer to double; the generated thunk
   converts it back. This is not a handwritten RAF-specific adapter.

The body/ABI separation and `cppAbiType` already exist in the current compiler
repository's initial commit, `a51b954c71b1e3ea463d4eb18950cd792c97ae57`
(September 20, 2026). The source comment records the reason: retain the common
calling convention used by callers and stored function pointers while narrowing
implementation bodies. This repository does not establish an earlier origin or
the individual reasoning behind that initial implementation.

That general convention supports function values shared across differently
typed callers. It is unnecessarily broad at this authenticated native boundary.
The native-signature fix supplied the missing integer input proof and fixed its
propagation, but did not add a native entry using the inspected callback ABI.
Its tests prove integer bodies, absence of duplicate bodies, and correct output;
they do not require a conversion-free native entry. Signature assertions also
cannot catch this: they correctly validate the host's integer signature, and
C++ legally adapts the double-taking callable to it.

The recorded production ELF retains a 148-byte
`std::_Function_handler<void(int), gea::CallableObject<void(double)>>::_M_invoke`
and an integer-to-double helper reference. All nine timestamp-taking stores have
one integer tick body. No separate FPS cost was measured for this adapter.

The correction belongs in compiler native-callable lowering: use the inspected
native callback convention to enter the proven integer implementation directly,
while retaining captured-environment ownership and function identity. Ordinary
function values still need their general declared convention where other uses
require it. Changing every TypeScript `number` to integer, changing the host
back to double, or casting the existing function pointer would bypass the actual
representation mismatch rather than resolve it.

## Historical integer alias reduction

The framework spells `int` as `number & { readonly [brand]?: never }` so normal
TypeScript can assign and read it as a number without casts. This brand has no
runtime field. Structural normalization preserves the intersection and its
declaration anchor; TypeScript has not lost the alias at that point.

The loss occurs in `src/representation/derive.ts`:
`substantiveMembersOf` drops `isVacuousBrand` members, and `deriveIntersection`
returns the representation of the remaining sole member. For `int` that member
is `number`. A declared host-native carrier can override this collapse, but
the integer alias has no such carrier. Callable ABI projection consumes the
already selected representations; it correctly does not reconstruct a different
ABI from annotations. The C++ printer then spells the numeric carrier `double`.

The general brand reduction is appropriate for ordinary TypeScript brands,
which label a value without changing its runtime representation. It already
exists in initial compiler commit `a51b954c7`. The framework's integer alias
also already exists in initial core commit `50b5540` (September 20, 2026).
Those histories establish that the alias and general reduction were present;
they do not establish the original author's intent beyond the source comments.

Before this fix, the integer opt-in implementation was a separate, uncommitted binding
census (`src/semantics/declared-integers.ts`), not a representation rule. It
skipped declaration files and only recorded variables or parameters with an
explicit annotation. Its output was consumed by late integer-storage analysis,
not by callable representation derivation. Consequently an ambient callback
signature is excluded, and an inferred callback parameter with no `node.type`
is excluded too. Even explicit integer bindings do not give the callable ABI
an integer carrier through this path.

That is the architectural defect: integer semantics were attached to selected
storage bindings after representations were chosen, while function parameter
and result types still use ordinary branded-Number reduction. The framework
comment claiming integer lowering for parameters and returns is broader than
what that implementation establishes. The latest signature-compatibility fix
only accepts the alias at inspection; it cannot repair representation derivation.

The fix recognizes integer contracts in the semantic/representation
authority before general brand reduction, then propagates that same integer
carrier through binding, callback parameter, result, and callable ABI decisions.
This avoids both losing contextual annotations and creating different calling
conventions at different consumers. Tests cover stored callback signatures
and inferred parameters, alongside binding arithmetic and
native values. A native entry adapter is a narrower boundary optimization;
it would not by itself correct the alias's general representation gap.

Verification uses the shared `dist/` build:

```sh
node --test dist/native-signatures.test.js
node --test dist/ir/native-callback-integer-storage.test.js
node --test dist/semantics/native-function-signatures.test.js
node test/native-callback-signatures.mjs
node test/declared-integer-contracts.mjs
npm run gate
```

The native execution harness compares generated programs against Node under
ASan/UBSan, including signed integer endpoints and fractional negative cases.
The target-signature test deliberately changes a callback to `double` through
a preprocessor macro and requires the target assertion to reject it.

### October 6 verification after cloning removal

`npm run build` completed successfully, including architecture, typechecking,
native runtime header compilation, and the standard build contract checks.

The shared compiler passed nine declared-integer contract execution scenarios
and four native callback execution scenarios under ASan/UBSan. Both former
cloning runtime fixtures passed with the guard and duplicate bodies absent;
the declared-integer storage fixture passed, including 64-bit wraparound.

The emitted-set gate returned failure: 49 corpus outputs and 690 runtime
outputs moved, with nine runtime additions, no losses, and 76 printer
refusals. Certified IR drift was zero. This is the result for the entire
existing uncommitted tree, not an attribution of every movement to this fix.
Tracked baselines were not replaced, and this result is not a green gate.

The wide-integer checks exposed two boundary assumptions corrected here:
decimal Number literals outside the safe integer range must be parsed as
double before conversion to declared integer storage, and int64 comparisons
cannot use bound helpers whose sentinels assume a safe-Number-range counter.
Ordinary Number results still round to double; integer-only arithmetic retains
its declared-width wrapping semantics without an intermediate rounded view.
