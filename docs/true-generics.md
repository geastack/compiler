# True generics: type parameters in the IR, templates in C++

Status: design note, 2026-09-23. No code has changed. Every file and function
named here was read in the tree as of that date; line numbers are from that
date and will drift.

## Summary

Today geatsc implements TypeScript generics by **re-deriving a copy of every
generic body per instantiation**. The frontend walks each generic subtree once
per copy, mints identities per copy (`decl|f168|1@0`), and the layers after it
spend several thousand lines deciding which copies are one struct, which are
several, which copy a read means, and which copy an override replaces. Most of
the generic-related defects of the last month were one of those decisions
answered wrongly.

This note proposes that the compiler treat a type parameter as a first-class
thing that survives into the IR:

- A generic body is normalized and lowered **once**. Operations on a
  type-parameter-typed value are abstract.
- Each instantiation is a **tuple of carriers** (the representation layer's
  answer for each filling), not a tuple of checker types. Two fillings with the
  same carrier are one instantiation.
- Emission is **C++ class and function templates** that clang instantiates.
  The compiler still decides every recipe; C++ only _selects_ among recipes the
  compiler already certified.
- A class's type parameters are split into **storage parameters** (reach
  instance storage; become C++ template parameters) and **convention
  parameters** (reach only method signatures; stay off the class and become a
  closed set of per-convention virtual slots, which is what already works today).
- Values that mix instantiations are carried as **one pointer to a non-template
  erased base**, with a closed (or `any`-open) member list as a static fact.
  Not a tagged union of copies.
- The static side is **one non-template struct per generic root**. TypeScript
  forbids statics from naming the class's type parameters (TS2302), so this is
  exact, not an approximation.
- Certification runs **per instantiation**. Every fail-closed guard stays. The
  C++ compiler becomes a second guard: dependent recipes are explicit
  specializations with no primary template, so an unlisted instantiation is a
  hard compile error, never a silent default.
- A parameter declared with a top-like type (`any`, `Document`, …) that
  receives a statically known carrier is an **implicit type parameter**. A
  reflective walk over it (`Object.keys`, `o[k]`, `instanceof`) then unrolls
  into static field code per argument carrier, so a typed document reaches
  bson's serializer without ever being boxed (§3(h)).

## 1. Current model

### 1.1 Enumeration: which copies exist

`src/semantics/normalize/specialization.ts` (2,689 lines) answers "which
instantiations does the program make" before anything is normalized. Its
header comment states the model: one copy of a generic body per distinct
instantiation, identified by an **ordinal** in deterministic walk order, never
by the spelling of its arguments.

A `Specialization` (`specialization.ts:40`) carries:

- `ordinal`, and `arguments` (the checker `ts.Type` per parameter);
- `instantiated`, the checker's own spelling (`Collection<Document>`), used
  because the public checker API cannot instantiate a type;
- `instantiatedSignature`, the `[open, resolved]` signature pair of the call
  that minted the copy;
- `bindingOf(parameter)` and `fillingOf(open)` for composites like
  `T[] -> string[]`.

`SpecializationCensus` (`specialization.ts:94`) is the published interface:
`specializationsOf`, `isGeneric`, `specializationAt`, `erasedAnyRefilledAt`,
`setSpecializationsAt`, `specializationOfInstance`, `copiesMayDifferInLayout`,
`canonicalLayoutFillings`, `reinterpretedCopyOf` and `admittedUnder`.

`censusSpecializations` (`specialization.ts:707`) builds it from several
sources:

| source                                                     | what it mints                                                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fromTypeReference` (:1209)                                | `Box<number>` written in a type position                                                                                                                                              |
| `fromCall` (:1483)                                         | call and `new` sites. Unifies the open signature against the resolved one (`unify` :502, `unifySignatures` :636); overloads mint the implementation's copy (`implementationOf` :1364) |
| `fromValueUse` (:1762), `closeOpenValueUses` (:1937)       | generic functions passed as values: one copy, from the contextual instantiation or else the constraints (`constraintBindingsOf` :1641)                                                |
| `induceFromHeritage` (:932)                                | the base copy a derived copy's `extends` names                                                                                                                                        |
| `erasedAnyFillingsOf` (:1413)                              | refills a parameter the checker inferred as `any` from an `x as any` argument                                                                                                         |
| `mintReinterpretationCopies` (:2090)                       | the `any` copy of a class cast between its own instantiations through `unknown`/`any`                                                                                                 |
| `mintOverrideCopies` (:2179) over `overrideGroups` (:2123) | every overriding generic method's copy at every tuple any member of its override group has                                                                                            |

The whole thing is closed under substitution by a fixpoint capped at 8 rounds
(`specialization.ts:2283`): a site written with a hole inside `outer<T>` mints
one copy of the callee per copy of `outer` (`filledBy` :2225,
`enclosingGenericsOf` :2207).

`src/semantics/normalize/instantiation.ts` (460 lines) is a second, older
census. For a parameter bound to exactly one type program-wide it answers that
binding, with the parameter's constraint as a lower-priority default. The
note `geatsc-generic-bound-only-through-absence` records that its
`withoutAbsence` and `specialization.ts`'s `unify` are a duplicated rule that
has already drifted once.

### 1.2 Keying: how a copy is named

- Tuple identity is **checker type identity**: `tupleOrdinal` and
  `ordinalOfArguments` (:785, :874) compare `ts.Type` objects with `===`, which
  works only because the checker interns types.
- A body's copy is a `SpecializationPath`: a list of `{owner, ordinal}` steps,
  outermost first (`identities.ts:33-47`). Its ordinals become an identity
  suffix (`specializationKey`, `identities.ts:57`), for example `decl|f168|62@0.1`
  for the `R = string` copy of `map` inside the `T = number` copy of `Box`.
- `copyKeyOf` (`identities.ts:92`) is a second key that includes the owner,
  because ordinals alone collide across unrelated generics. Its doc comment
  records the defect that motivated it.
- `withoutSpecialization` (`identity/ids.ts:122`) trims the suffix, so that
  diagnostics can find a source position and so that the lifecycle census can
  accept both spellings (note `geatsc-generic-class-static-copy-id`).

### 1.3 Walking: bodies are re-normalized per copy

`census.ts:689`: for a generic subject, the subtree is walked **once per copy**,
with the copy pushed onto the path. Every node, operation, structural mapper
and flow fact under it is minted again. `admittedUnder` (`specialization.ts`,
in the census object) prunes cross-product copies that could not type-check
(a database driver's `emitAndLog<EventKey extends keyof Events>`). `deadMethodCopies`
(`dead-method-copies.ts`, 288 lines) prunes copies of an abstract generic
class's method body that no dispatch lands on (a database driver's
`AbstractOperation.handleOk` at `number`, where `as TResult` has no native
meaning).

In the structural layer, `forSpecialization(path, bindingPath)`
(`structural.ts:169`) gives each copy its own `StructuralMapper`, cached by
`copyKeyOf` (`structural.ts:394-399`). Substitution goes through
`structural-generics.ts` (198 lines: `createPathBinding`,
`createPathSubstitution`, `heritageCopyOf`, `createTypeParameterSubstitution`).
Composite member types go through `structural-instantiated-member.ts` (498
lines), which pairs the open member against the checker's instantiated
spelling. Substitution can only rewrite a bare `T`, because the checker API has
no `instantiateType` (note `geatsc-copy-members-need-the-instantiated-spelling`).

### 1.4 Classes: split or fold, decided after the fact

A generic class's copies may be one struct or several, and that is decided in
three places:

1. `copiesMayDifferInLayout` (`specialization.ts`, census object) says whether
   the copies _may_ split. It looks at the layout-relevant parameters
   (`layoutRelevantParameterIndices`, `structural-layout-relevance.ts:266`),
   whether they reach instance storage (`parametersInInstanceStorage`, :376),
   whether the base splits (`baseCopiesDiffer` :962), and pairwise
   **assignability** (`checker.isTypeAssignableTo`).
   `canonicalLayoutFillings` picks the fold target for a class that must not
   split, and `canonicalOrdinalOf` redirects every site to it.
2. `structural.ts` records copies only on the split path
   (`recordClassCopy` :1471, `foldedCopyOf`, `copyOfClassInPath` :1437, which
   is last-step-wins). It also folds a reinterpreted class onto its `any` copy
   (around :2660).
3. `representation/derive.ts` groups copies by the **representation key** of
   their fillings (`classGroupsOf` :2097, `classArgumentKeyOf`) and names each
   group `root@k` (`physicalClassGroupOf` :2127, `physicalCopyDeclarationOf`).
   A class spelled at `any` whose copies split becomes a tagged union of its
   copies' `class-ref`s (`anyCopyFamilyOf` :2196). Because that union is also
   the `any` copy's own instance type, exact producers must opt out through
   `exactClassInstanceOf` (:2277). That opt-out in turn needs
   `SignatureShape.implicitReceiver` (`model/structural-types.ts:123`),
   `ReferenceOperation.classBoundReceiver` (`model/operations.ts:76`) and
   `exactClassInstanceReadOf` (`representation/publish.ts:499`).

`projection/classes.ts` then reassembles physical classes from per-copy events.
`collapseSpecializations` (:498) buckets layouts by physical id.
`mergedMethods` (:440) dedupes identical copies by key and convention; without
it, clang rejected the redefinitions. `shareStaticSides` (:473) gives every
layout of one root the union of static members, with `staticOwner` pointing at
the root. `withBaseCopies` (:1008) records `ClassLayout.baseCopies`, which says
which base copy each copy's heritage names. `ClassMethod.publishedBy` (:70)
says which class copy installed a method body. `classLayoutOfCopy` (:240) and
`sharedStaticOwnerOf` (:222) resolve them. `ir/lower.ts`'s
`familyNamesClassCopy` (:740) accepts either spelling of a class.

### 1.5 Methods and dispatch: resolving copies by convention

Every copy of a generic method installs under the one key the copies share, so
`ClassLayout.methods` holds several entries per key. Which one a site means is
recovered by **matching conventions**:

- `ir/call-dispatch.ts:677` `methodCopyPreferenceOf`: a read picks the copy
  whose receiverless ABI matches its own. Its doc comment says that "matching
  nothing falls back to the first".
- `targets/cpp/class-properties/computed-method-value.ts`: `heldMethodCopyOf`
  and `publishedMethodCopyOf` redo the same choice for computed reads and union
  arms, through `methodCopyHeldBy` (`projection/dispatch.ts:308`).
- `projection/dispatch.ts:412` `classCopyFamiliesOf` splits a virtual family
  rooted at a generic class into one family per root copy, following
  `publishedBy` and `baseCopies` up the lineage. `virtualCopyFamiliesOf` (:363)
  falls back to partitioning by convention. `copyAbsentFrom` refuses a copy
  that some override lacks.

What reaches C++ is already close to the target model for convention-only
parameters. For `test/runtime/generic-override-copy-through-class-union-arm.runtime.ts`,
`AbstractOperation<TResult>` (whose `TResult` never reaches storage) is **one
struct with one virtual slot per convention**:

```cpp
struct gea_class_decl_f168_27 {
  virtual gea::Ref<gea::Dictionary<gea::Value>> gea_vcall_handleOk_c025fe119(gea::Ref<gea_class_decl_f168_9> gea_arg_0);
  virtual double gea_vcall_handleOk_c6aed7012(gea::Ref<gea_class_decl_f168_9> gea_arg_0);
  virtual void gea_vcall_handleOk_cb2b228dc(gea::Ref<gea_class_decl_f168_9> gea_arg_0);
};
struct gea_class_decl_f168_97 final : gea_class_decl_f168_87 {  // CountOperation
  double gea_vcall_handleOk_c6aed7012(gea::Ref<gea_class_decl_f168_9> gea_arg_0) override;
};
```

A storage-relevant parameter instead produces separate structs with
per-copy everything. Here is `test/runtime/generic-class-two-layouts.ts`
emitted today (`node dist/cli.js … --no-project --emit`, trimmed):

```cpp
struct gea_class_decl_f168_1_0 final { double value; /* + ~170 lines of reflection hooks */ };
struct gea_class_decl_f168_1_1 final { std::string value; /* same hooks, again */ };
struct gea_class_decl_f168_1_2 final { bool value; /* same hooks, again */ };
double gea_static_field_gea_class_decl_f168_1_count;              // one static cell: correct
gea::ConstructorObject<gea::Ref<gea_class_decl_f168_1_0>(double)> gea_global_decl_f168_1_0;
gea::ConstructorObject<gea::Ref<gea_class_decl_f168_1_1>(std::string)> gea_global_decl_f168_1_1;
gea::ConstructorObject<gea::Ref<gea_class_decl_f168_1_2>(bool)> gea_global_decl_f168_1_2;
double gea_body_fn_decl_f168_53_0(const gea::Ref<gea_class_decl_f168_1_0>& gea_this);       // get, T=number
std::string gea_body_fn_decl_f168_53_1(const gea::Ref<gea_class_decl_f168_1_1>& gea_this);  // get, T=string
gea::Ref<gea_class_decl_f168_1_1> gea_body_fn_decl_f168_62_0_1(                             // map<string> in Box<number>
    const gea::Ref<gea_class_decl_f168_1_0>& gea_this, gea::CallableObject<std::string(double)> gea_arg_0);
```

The program is 30 lines of TypeScript and emits 880 lines of C++. Each copy is a
full, separately printed text.

Measured scale on the one recent full HTTP framework build in the tree
(node-compat's HTTP framework test app, 2026-09-23): 607 body
definitions. 201 of them sit inside a generic copy path, spread over 173
distinct generic roots, so most generic bodies there have exactly one copy.
The copy machinery is load-bearing for **correctness** on that framework. It does not
carry much size.

### 1.6 Invariants the copy model maintains

Any replacement has to keep these. Each is enforced somewhere today, often by
a guard that a bug report forced into existence.

1. **No open type parameter reaches representation.** `derive.ts:2961` refuses
   `type-parameter` shapes ("reached representation without
   monomorphization"), except under opt-in fallback.
2. **A copy's identity is not its spelling.** Ordinals, not type names
   (Absolute constraint 1 in `ARCHITECTURE.md`).
3. **An uninstantiated generic emits nothing** (`census.ts:700`): walking it
   would publish a carrier that is the open hole.
4. **One JavaScript class value, one static side.** `Box.count` is one cell
   for every layout (`shareStaticSides`).
5. **Distinct physical layouts are distinct C++ types**, and sharing a struct
   is legal only where the difference never reaches mutable storage (note
   `geatsc-folding-class-copies-is-unsound-at-mutable-storage`).
6. **Object identity is preserved** wherever JavaScript would observe it: the
   same object in two slots of two static views must still be `===`.
7. **Every override exists at every convention its family is called at**
   (`mintOverrideCopies`), or the family refuses by name (`copyAbsentFrom`).
8. **`any` and `unknown` differ.** `any` is the unchecked top and may fold;
   `unknown` is checked and may not.
9. **No boxing of a statically typed value**, per instantiation.

### 1.7 Bug classes the copy model produced

Every row is a real defect, each with a runtime test or memory note. They
cluster into five shapes. All five come from the same cause: **a decision was
made on a copy, and a later layer had to recover which copy it was.**

| #   | shape                                               | instances                                                                                                                                                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | **wrong copy by name/first-match**                  | Union-of-classes receiver picked the class's first (`void`) copy of `handleOk` (`generic-override-copy-through-class-union-arm.runtime.ts`). Generic method copies all under one key, `classMemberOf` took the first (`generic-method-at-two-type-arguments.ts`). `methodCopyPreferenceOf`'s "falls back to the first".                                                               |
| B   | **fold vs split decided with the wrong instrument** | `c61d97066` broke the framework build: `copiesMayDifferInLayout` used assignability, one `any` filling collapsed every copy onto one struct, and the first completer's carriers won (`geatsc-layout-identity-must-be-representation-not-assignability`). Folding `Queue<unknown>` onto `Queue<Uint8Array>` aborted at runtime (`generic-class-at-a-top-type-and-a-concrete-type.ts`). |
| C   | **the `any` copy is two things at once**            | Classes split at `any` became a tagged union of copies. The `any` copy's own `this` then needed `exactClassInstanceOf`, `implicitReceiver`, `classBoundReceiver`, and a construct-result override (`geatsc-any-copy-family-union`).                                                                                                                                                   |
| D   | **override families and heritage per copy**         | Override copies missing at some base instantiations (`mintOverrideCopies`, `generic-method-override-minted-at-every-base-copy.runtime.ts`). Override families needed a per-copy split (`classCopyFamiliesOf`). A derived class had to split when its base's copies split (`baseCopiesDiffer`, `derived-class-splits-with-its-base`).                                                  |
| E   | **two spellings of one class**                      | Statics refused as `constructor-family(uncensused)` because lifecycle events named `@0` while the carrier named the root (`geatsc-generic-class-static-copy-id`). A generic class needed several physical classes and one shared static side (`shareStaticSides`, `generic-class-two-layouts.ts`). `familyNamesClassCopy` accepts either spelling.                                    |

Plus the enumeration's own holes: `T` bound only through `T | undefined` minted
no copy (`geatsc-generic-bound-only-through-absence`). Nested holes needed
composite fillings (`geatsc-overload-copies-belong-to-the-implementation`).
Heritage-induced copies have no checker image, and trying to give them one
regressed the probe from 550 to 1263 (`geatsc-copy-members-need-the-instantiated-spelling`).

**Size.** Whole files are `specialization.ts` 2,689, `instantiation.ts` 460,
`structural-instantiated-member.ts` 498, `structural-generics.ts` 198 and
`dead-method-copies.ts` 288, totalling 4,133. `layout-relevance`,
`class-heritage.ts`'s copy half and `generic-function-choice.ts` add about 600
more. A keyword census (`copies|specializ|physicalClass|staticOwner|baseCopies|publishedBy|…`)
hits more than 40 non-test files outside those. The heaviest are
`structural.ts` (211 hits), `producers/shared.ts` (146), `derive.ts` (86),
`dispatch.ts` (82), `identities.ts` (76) and `parameter-bindings.ts` (71). That
agrees with the 5–8k scattered-lines estimate, out of about 246k lines of
compiler source.

## 2. Target model

### 2.1 Principles

1. **A type parameter is a value in the semantic model, not a hole to be
   filled before modelling.** A generic body exists once.
2. **The compiler remains the only authority on every recipe.** C++ templates
   are a _printing_ device. No conversion, dispatch or coercion decision moves
   into C++ overload resolution or template metaprogramming. That would be a
   second authority, and it would hide decisions from certification.
3. **Instantiation identity is representation identity.** The key is the tuple
   of carriers, the question `classArgumentKeyOf` already asks correctly
   (`derive.ts`). Checker type identity and assignability are never used.
4. **Fail closed, twice.** Certification checks every instantiation. Emitted
   C++ is written so that anything certification did not list fails to compile.

### 2.2 The semantic model

`StructuralShape` already has a `type-parameter` kind. What changes is that it
is no longer an error to reach representation with one.

- **`Representation` gains `{ kind: 'type-parameter'; owner: DeclarationId; index: number }`.**
  Composite carriers may contain it: `array-object(element: T0)`,
  `optional(T0)`, `promise(T0)`, `class-ref(Box<T0>)`,
  `function((T0) -> R0)`.
- **A generic declaration gets one `DeclarationId` and one `FunctionId`.** The
  `@ordinal` suffix, `SpecializationPath` in identities, `copyKeyOf` and
  `withoutSpecialization` go away. An instantiation is a separate key,
  `InstantiationKey = { generic: DeclarationId; carriers: readonly RepresentationKey[] }`,
  which never appears inside a node or declaration id.
- **Type parameters are classified once, per declaration**, from facts the
  frontend already computes:
  - _storage_: reaches instance storage (`parametersInInstanceStorage`,
    including callable-typed fields per `structural-layout-relevance.ts`). These
    become C++ class template parameters.
  - _convention_: appears only in member signatures (a database driver's `TResult`).
    These are not class template parameters (§3b).
  - For functions, every parameter is a template parameter.
- **Type-level computations over parameters** (`JSTypeOf[T]`, `WithId<T>`,
  `Parameters<Events[K]>`, `Awaited<T>`) remain the checker's job. The
  instantiated-spelling mechanism (`structural-instantiated-member.ts`) is kept
  and repurposed: for each instantiation it produces the closed type of each
  such expression, which becomes a compiler-emitted type trait (§2.5).

### 2.3 Enumeration stays, and shrinks

C++ instantiates templates implicitly, but the compiler still needs the
instantiation set. Certification is per instantiation, closed-set dispatch
needs the member list, and dependent recipes are emitted as explicit
specializations. So enumeration survives with a different output:

- Sources: `fromTypeReference`, `fromCall` (including `unify` and the
  implementation-owns-overloads rule), `fromValueUse`, `induceFromHeritage`, and
  the enclosing-generic fixpoint. All are unchanged in _what they bind_.
- Output: an `InstantiationKey` per reached tuple, computed by deriving each
  filling's carrier. Fillings with the same carrier merge **before** anything
  is lowered. `Carrier<'a' | 'b'>` and `Carrier<string>` are one instantiation
  by construction, not by a later fold (`physicalClassGroupOf`'s job today).
- Reachability: an instantiation exists because a reached site or a reached
  instantiation names it. A method of a class template is instantiated only if
  a reached site calls it (or a virtual slot needs it, §3b). This replaces
  `admittedUnder`: the driver's `emitAndLog` cross-product copy is simply never
  requested.
- Deleted: `copiesMayDifferInLayout`, `canonicalLayoutFillings`,
  `canonicalOrdinalOf`, `baseCopiesDiffer`, the assignability instrument, and
  the fold. Storage parameters always split, and a split is just two carrier
  tuples.

### 2.4 The IR: lowered once, three kinds of operation

A generic body is lowered once with `type-parameter` representations in its
operands. Every operation falls into exactly one class:

1. **Independent.** No operand or result mentions a parameter. This is the
   majority of any real body. It is lowered and emitted exactly as today.
2. **Uniform.** It mentions parameters, but its recipe is the same for every
   carrier: moving or copying a `T0` value, storing `T0` into a `T0` field,
   passing `T0` to a `T0` formal, returning `T0`, constructing `Box<T0>`,
   calling `f<T0>`, and array element read or write of `T0` in
   `ArrayObject<T0>`. The IR records it once, and the emitter spells `T0`.
3. **Dependent.** The recipe depends on the carrier: property access on a
   `T`-typed receiver, a conversion whose source or target mentions `T` (for
   example `T -> string | T`, `T -> optional(T)`, `T` into an `any` slot),
   `typeof`/`instanceof`/`in` on `T`, `===`, `ToString`, `ToNumber`, a call
   through a `T`-typed callee, and arithmetic on a constrained `T`. The IR holds
   a `DependentSite { site, open operation }`. A **resolution table**,
   `resolve(site, instantiation) -> lowered fragment`, is computed by running
   the ordinary producer and lowering over the _substituted_ operand types for
   that one site.

Dependent **regions**: a branch guarded by a narrowing on a parameter
(`typeof x === 'string'` with `x: T`) types its body with the narrowed
`T & string`. Per instantiation the guard's verdict is _always_, _never_ or
_runtime_ (the last only for a `dynamic` carrier, that is `T = any/unknown`).
The region is lowered once per distinct verdict class that occurs, **not once
per instantiation**. This fixes the open issue in
`geatsc-overload-copies-belong-to-the-implementation`, where a branch dead
under uninhabited narrowing (`Array.isArray` in a scalar copy) is still lowered
today.

The resolution table is where the remaining per-instantiation work lives, but
at the granularity of a _site_, not a _body_. A body with twelve independent
statements and one `String(value)` does one per-instantiation resolution, not
twelve.

### 2.5 From type arguments to C++ types

- A template argument is `cppTypeOf(σ(T))`, where `σ` substitutes the
  instantiation's carriers. The representation layer is the only authority.
  The template layer asks it and never computes a spelling.
- Template parameters are constrained by a runtime concept that admits carrier
  types only (no references, no cv, no `const char*`):

  ```cpp
  namespace gea {
  template <typename T>
  concept Carrier = std::is_object_v<T> && !std::is_const_v<T> && !std::is_pointer_v<T> && std::is_destructible_v<T>;
  }
  ```

- **Type-level expressions** (conditional, indexed, mapped, `Awaited`) in a
  generic body become compiler-emitted traits. Each has **no primary
  definition** and one explicit specialization per instantiation:

  ```cpp
  template <typename K> struct gea_tl_decl_f40_12;     // JSTypeOf[K] in OnDemandDocument.get<K>
  template <> struct gea_tl_decl_f40_12<gea::lit::object>    { using type = gea::Ref<gea::Dictionary<gea::Value>>; };
  template <> struct gea_tl_decl_f40_12<gea::lit::timestamp> { using type = gea::Optional<gea::Ref<gea_class_decl_f41_3>>; };
  ```

  A literal-typed filling whose literal matters to a type-level computation
  (a database driver's `get<'object'>` vs `get<'timestamp'>`) is carried as a
  compiler-emitted tag type (`gea::lit::object`). That keeps the two apart even
  though both carriers are `std::string`. **The instantiation key is the carrier
  tuple, refined by any literal the body's type-level traits read.** A
  fixed-string non-type template parameter would also work in C++20. Tag types
  are chosen instead because they keep every template argument a type, which
  one concept can constrain.

### 2.6 Emission: class and function templates

The running example, in TypeScript:

```ts
class Box<T> {
  static count = 0
  static create<U>(value: U): Box<U> {
    return new Box<U>(value)
  }
  label = 'box'
  value: T
  constructor(value: T) {
    this.value = value
    Box.count += 1
  }
  get(): T {
    return this.value
  }
  map<R>(transform: (value: T) => R): Box<R> {
    return new Box<R>(transform(this.value))
  }
  describe(): string {
    return typeof this.value === 'string' ? 'text ' + this.value : this.label + ' ' + String(this.value)
  }
}

function indexOf<T>(items: T[], wanted: T): number {
  for (let i = 0; i < items.length; i++) if (items[i] === wanted) return i
  return -1
}

const n = new Box<number>(1)
const s = n.map((v) => 'v' + v) // Box<string>
console.log(n.describe(), s.describe(), indexOf([1, 2], 2), indexOf(['a'], 'a'))
const boxes: Box<any>[] = [n, s] // mixes instantiations: §3a
for (const b of boxes) console.log(b.label, b.get())
```

Instantiations the enumeration produces: `Box<double>`, `Box<std::string>`,
`Box::map<double, std::string>`, `indexOf<double>` and
`indexOf<std::string>`. `Box<any>` is **not** an instantiation, because nothing
constructs one. It is a slot type (§3a).

The emitted C++ in the target model, with names following today's scheme
(reflection hooks elided the same way the excerpt above elides them):

```cpp
// ---- static side: one per generic ROOT, never a template. TS2302 forbids a
// static member from naming the class's type parameters, so nothing here can
// depend on T0. One `count` cell, one `create`, one constructor object.
struct gea_static_decl_f168_1 {
  double count = 0;
};
inline gea_static_decl_f168_1 gea_statics_decl_f168_1;

// ---- erased base: identity, prototype hooks, and the storage that does not
// depend on any storage parameter. A `Ref<erased>` is what a mixed slot holds.
struct gea_class_decl_f168_1_erased {
  static inline gea::Ref<gea::NativeClassMethodState> gea_method_state;
  std::string label;
  virtual ~gea_class_decl_f168_1_erased() = default;
  // Demand-driven: emitted only because `b.get()` is read through a Box<any>
  // slot. Declared-any convention; see §3a.
  virtual gea::Value gea_vcall_get_any() = 0;
  virtual bool gea_readPrototypeProperty(const gea::PropertyKey&, gea::Value&) const = 0;
};

// ---- the instance template: T0 is a STORAGE parameter.
template <gea::Carrier T0>
struct gea_class_decl_f168_1 final : gea_class_decl_f168_1_erased {
  T0 value;
  gea::Value gea_vcall_get_any() override { return gea_box_decl_f168_1_value<T0>::apply(value); }
  bool gea_readPrototypeProperty(const gea::PropertyKey& key, gea::Value& out) const override;
  // gea_ownFieldPresent / gea_readOwnField / ... : printed ONCE, not per copy.
  // Their only T0-dependent line (boxing `value`) goes through the same trait.
};

// A dependent recipe the compiler certified per instantiation. No primary: an
// instantiation certification never saw is a C++ compile error.
template <typename> struct gea_box_decl_f168_1_value;
template <> struct gea_box_decl_f168_1_value<double> {
  static gea::Value apply(double v) { return gea::Value::box(gea::Value::Tag::Number, v); }
};
template <> struct gea_box_decl_f168_1_value<std::string> {
  static gea::Value apply(const std::string& v) { return gea::Value::box(gea::Value::Tag::String, v); }
};

// ---- construct: a function template, one constructor object for the root.
template <gea::Carrier T0>
gea::Ref<gea_class_decl_f168_1<T0>> gea_construct_decl_f168_1(T0 gea_arg_0) {
  gea::Ref<gea_class_decl_f168_1<T0>> gea_this = gea::makeRef<gea_class_decl_f168_1<T0>>();
  gea_this->label = std::string("box");
  gea_this->value = gea::exact<T0>(std::move(gea_arg_0));
  gea_statics_decl_f168_1.count += 1;
  return gea_this;
}

// ---- static create<U>: an ordinary function template (U is its own parameter).
template <gea::Carrier U0>
gea::Ref<gea_class_decl_f168_1<U0>> gea_body_fn_decl_f168_9(U0 gea_arg_0) {
  return gea_construct_decl_f168_1<U0>(gea::exact<U0>(std::move(gea_arg_0)));
}

// ---- get(): uniform, no dependent site.
template <gea::Carrier T0>
T0 gea_body_fn_decl_f168_53(const gea::Ref<gea_class_decl_f168_1<T0>>& gea_this) {
  return gea::exact<T0>(gea_this->value);
}

// ---- map<R>(): the method's own parameter is a template parameter too.
template <gea::Carrier T0, gea::Carrier R0>
gea::Ref<gea_class_decl_f168_1<R0>> gea_body_fn_decl_f168_62(const gea::Ref<gea_class_decl_f168_1<T0>>& gea_this,
                                                              gea::CallableObject<R0(T0)> gea_arg_0) {
  R0 v0 = gea::exact<R0>(gea_arg_0(gea::exact<T0>(gea_this->value)));
  return gea_construct_decl_f168_1<R0>(std::move(v0));
}

// ---- describe(): one dependent REGION (the typeof guard) and one dependent
// site (String(value)). Verdicts: T0=double -> never, T0=string -> always.
template <typename> struct gea_dep_decl_f168_70_d0;   // typeof this.value === 'string'
template <> struct gea_dep_decl_f168_70_d0<double> { static constexpr gea::Verdict verdict = gea::Verdict::Never; };
template <> struct gea_dep_decl_f168_70_d0<std::string> { static constexpr gea::Verdict verdict = gea::Verdict::Always; };
template <typename> struct gea_dep_decl_f168_70_d1;   // String(this.value), reached only under `never`
template <> struct gea_dep_decl_f168_70_d1<double> {
  static std::string apply(double v) { return gea::numberToString(v); }
};

template <gea::Carrier T0>
std::string gea_body_fn_decl_f168_70(const gea::Ref<gea_class_decl_f168_1<T0>>& gea_this) {
  if constexpr (gea_dep_decl_f168_70_d0<T0>::verdict == gea::Verdict::Always) {
    // narrowed: T0 & string == std::string in every instantiation reaching here
    return std::string("text ") + gea::exact<std::string>(gea_this->value);
  } else {
    static_assert(gea_dep_decl_f168_70_d0<T0>::verdict == gea::Verdict::Never);
    return gea_this->label + std::string(" ") + gea_dep_decl_f168_70_d1<T0>::apply(gea_this->value);
  }
}

// ---- indexOf<T>(): `items[i] === wanted` is a dependent site whose certified
// recipes coincide for double and std::string (`a == b`), so it FOLDS to one
// inline spelling. A class-ref instantiation would have rendered
// `a.get() == b.get()` and the site would print a trait instead.
template <gea::Carrier T0>
double gea_body_fn_decl_f168_90(const gea::Ref<gea::ArrayObject<T0>>& gea_arg_0, const T0& gea_arg_1) {
  for (double i = 0; i < gea_arg_0->length(); i += 1) {
    if (gea::exact<T0>(gea_arg_0->at(static_cast<std::size_t>(i))) == gea::exact<T0>(gea_arg_1)) return i;
  }
  return -1;
}

// ---- explicit instantiation DEFINITIONS: the certified set, pinned to this
// TU. Other TUs see `extern template` declarations (§3g).
template struct gea_class_decl_f168_1<double>;
template struct gea_class_decl_f168_1<std::string>;
template gea::Ref<gea_class_decl_f168_1<std::string>> gea_body_fn_decl_f168_62<double, std::string>(
    const gea::Ref<gea_class_decl_f168_1<double>>&, gea::CallableObject<std::string(double)>);
template double gea_body_fn_decl_f168_90<double>(const gea::Ref<gea::ArrayObject<double>>&, const double&);
template double gea_body_fn_decl_f168_90<std::string>(const gea::Ref<gea::ArrayObject<std::string>>&, const std::string&);
```

And the module body's mixed-instantiation loop:

```cpp
// `const boxes: Box<any>[] = [n, s]` -- element carrier is the erased base.
gea::Ref<gea::ArrayObject<gea::Ref<gea_class_decl_f168_1_erased>>> boxes = gea::makeArray<gea::Ref<gea_class_decl_f168_1_erased>>({
    gea::Ref<gea_class_decl_f168_1_erased>(n), gea::Ref<gea_class_decl_f168_1_erased>(s)});  // C++ upcast, identity kept
for (/* ... */) {
  const gea::Ref<gea_class_decl_f168_1_erased>& b = /* element */;
  gea::consoleLog(b->label, b->gea_vcall_get_any());    // label: direct field; get(): declared-any slot
}
```

The rule the emitter applies to every dependent site is mechanical. Render
the certified recipe for each instantiation with the instantiation's carriers
spelled as the template parameter names. If every rendering is the same text,
print it inline. Otherwise print a trait with one explicit specialization per
instantiation, and no primary. The fold is valid only because each
instantiation's recipe was **separately certified** to be that text, and
`gea::exact` pins the operand types the recipe was certified at.

### 2.7 How each `T`-dependent operation is emitted

| operation                                                                                                  | resolution (per instantiation, by the existing producer and lowering on substituted types)                                                           | emission                                                                                                   |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| property access `x.p`, `x: T extends { p: number }`                                                        | whatever `x`'s substituted carrier gives: record field, class member (`classMemberOf`), dictionary, host member                                      | fold if the rendered texts are identical, else trait `apply(x)`                                            |
| conversion `T -> U` where either mentions a parameter (`T -> optional(T)`, `T -> string \| T`, `T -> any`) | `conversion/build.ts` on the substituted pair, as today                                                                                              | trait per instantiation. Never a C++ converting constructor (§2.8)                                         |
| `typeof x`                                                                                                 | constant from the carrier, or runtime for `dynamic`                                                                                                  | a constant folds. A comparison guard is a dependent region with an `if constexpr` verdict chain            |
| `x instanceof C`                                                                                           | carrier statically a descendant: always. Unrelated class: never. Family ref or `dynamic`: runtime (`hasNativeClassLayoutRef`/`classIdentityExtends`) | verdict chain. Runtime arm calls the existing helpers                                                      |
| `k in x`                                                                                                   | static key presence from the layout, or runtime (`gea_ownFieldPresent`)                                                                              | verdict chain                                                                                              |
| `===` / `!==`                                                                                              | scalar/string: value compare; `class-ref`: identity; `dynamic`: `strictEquals`; NaN rules per carrier                                                | fold where texts agree, else trait                                                                         |
| `ToString` / `ToNumber` / `+`                                                                              | the carrier's own recipe (`numberToString`, identity, record `[object Object]`, ...)                                                                 | trait                                                                                                      |
| call through `T`-typed callee (`f: T extends (...a) => R`)                                                 | the callable's ABI under `σ`                                                                                                                         | fold when every instantiation's ABI renders the same call text, else trait                                 |
| method call on `T`-typed receiver                                                                          | the exact target or virtual family under `σ` (`ir/call-dispatch.ts`)                                                                                 | trait wrapping the chosen call. **No convention-matching preference**: the target is computed, not matched |
| `new Box<T>()`, `f<T>()`                                                                                   | uniform                                                                                                                                              | `gea_construct_…<T0>` / `gea_body_…<T0>` directly                                                          |

"Fold" always means identical _text_, not identical meaning. Two class
instantiations whose `p` is a data member both render `x->p` and fold, even
though the struct types differ. A field in one and an accessor in the other
render differently and get a trait. That is the whole rule.

`if constexpr` is the only compile-time branching construct used, and only on
verdicts the compiler emitted. Discarded branches are not instantiated. That is
exactly what lets the narrowed region contain `gea::exact<std::string>` for an
instantiation where the value is a `double`.

### 2.8 C++ implicit conversions: the danger and the guard

A template body is type-checked by clang per instantiation, and C++ will
**silently convert** where the compiler's recipes assumed exactness. Real
hazards in this runtime:

- `gea::Optional<T>`'s converting constructor `template <typename U> Optional(U&& value)`
  (`targets/cpp/runtime/gea_runtime.h:6529`) calls `T(std::forward<U>(value))`.
  `Optional<long long>` from a `double` truncates. `Optional<bool>` from
  anything convertible compiles.
- Integer-narrowed locals are `long long` (see
  `geatsc-negative-zero-is-not-a-narrowable-integer`). A `T0 = double`
  template storing a `long long` expression converts silently, and a
  `T0 = long long` storing a `double` truncates.
- `bool` accepts pointers and every arithmetic type. `std::string` accepts
  `const char*`. `gea::Promise` has converting constructors that exist "for
  exactly one call site" (`gea_runtime.h`, `Promise` doc).
- Unqualified calls in templates do ADL. The note `geatsc-any-copy-family-union`
  records `sameValueZero` becoming ambiguous through ADL on a `CallableObject`
  element.
- `gea::Value` has no implicit converting constructors (boxing is always
  `Value::box(tag, v)`), which is good and must stay that way.

The guard, all four parts required:

1. **`gea::exact<T>(expr)` at every operand the IR records as a
   parameter-typed value** (uniform ops and dependent-site operands):

   ```cpp
   namespace gea {
   template <typename T, typename X>
     requires std::same_as<std::remove_cvref_t<X>, T>
   constexpr X&& exact(X&& value) noexcept { return std::forward<X>(value); }
   }
   ```

   An instantiation where the expression's C++ type is not exactly the carrier
   the compiler certified fails to compile. It never converts.

2. **Trait `apply` functions take exactly the certified parameter type, and
   each trait family deletes a catch-all:**
   `template <typename X> static void apply(X) = delete;`. Overload
   resolution then never picks a converting candidate.
3. **Every runtime helper call in template bodies is fully qualified**
   (`::gea::…`), which disables ADL.
4. **Converting constructors of runtime carriers get `requires` clauses
   restricting them to the conversions the conversion algebra installs.**
   `Optional(U&&)` becomes `requires gea::InstalledWidening<U, T>`, a trait the
   emitter specializes only for recipes it certified. This is a runtime-header
   change and lands as its own slice (slice 2).

Compiler flags for template TUs: `-Werror=conversion -Werror=sign-conversion
-Werror=float-conversion` restricted to the template section via `#pragma
clang diagnostic`, as a third net behind `exact` and the deleted catch-alls.

## 3. The hard parts

### (a) Values that mix instantiations

The cases: `Base<number>` and `Base<string>` flowing into one slot; a
`Base<any>` or bare `Base` slot (a database driver's `Set<AbstractCursor>`,
`session.owner`, `new ReadableCursorStream(this)`); a union of instantiations;
and TS covariance (`Box<Dog>` into `Box<Animal>`, `Token<number>` into
`Token<unknown>`).

Options considered:

1. **Tagged union of instantiations** (today's `anyCopyFamilyOf`). Exact and
   no boxing, and conversions already exist. But it needs every arm known at
   derive time, it grows with N, it cannot express an open `any` set, identity
   needs an arm-aware comparison, and it is what created bug class C (the
   `any` copy's own `this` is also the union).
2. **Uniform storage for any-reachable classes** (store `T` as `gea::Value`
   whenever an instance is ever viewed at `any`). This boxes typed fields and
   violates the no-boxing rule. It is also the unsound fold of note
   `geatsc-folding-class-copies-is-unsound-at-mutable-storage`. Rejected.
3. **Virtual/MI "view interfaces" per slot type** (`Box<Dog>` implements
   `BoxView<Animal>`). This needs multiple or virtual inheritance, which breaks
   the single-chain `Ref` upcasts and `classIdentityExtends`, and needs
   `dynamic_cast`. Rejected.
4. **Erased base pointer plus a static member list.** Chosen.

**Decision.** Every generic class template derives from a non-template
`G_erased`. That in turn derives from whatever non-generic class `G` extends.
A generic subclass `D<U> extends G<f(U)>` derives from `G<f(U)>` (single
chain), and the erased base of the chain is `G_erased`, the erased base of the
**topmost generic root** of the chain. A slot whose static type admits more
than one instantiation gets a new representation:

```
{ kind: 'class-family-ref', base: DeclarationId /* G */, members: readonly InstantiationKey[] | 'open' }
```

It is spelled `gea::Ref<G_erased>`. `members` is the closed list the flow
census proves can reach the slot. It is `open` exactly when the slot's type has
a top-type argument in a storage position and the flow proof cannot close it.
Member access through such a slot, in order:

1. **Members stored on `G_erased`** (T-independent fields of the topmost
   generic root and everything above it) are direct field access. No dispatch.
2. **Virtual slots whose convention does not mention a storage parameter** are
   one virtual call through `G_erased`'s vtable. This is ordinary C++ dispatch
   and needs no member list.
3. **Everything else** (a `T`-typed field, a `D`-specific member of a `D<any>`
   slot) with a closed member list is a closed identity switch over the list
   (`hasNativeClassLayoutRef<D<X>>` per member, the mechanism
   `overriddenMethodValueText` already renders). Each arm's result is converted
   to the slot's read type (a union when the arms differ).
4. With an `open` list, a `T`-dependent member is readable only at its
   **declared-`any` convention**, through a demand-driven virtual on
   `G_erased` (`gea_vcall_get_any` above). This boxes, and the boxing is
   licensed because the reader's declared type is `any`. That is
   `declared-any-never-narrowed`, not a new reason. Writes through an open
   slot are a per-instantiation checked unbox that throws `TypeError` on
   mismatch (memory safe; see (f)).

Why this and not the tagged union:

- **Identity is preserved by construction.** One pointer. `===`, `Set`/`Map`
  membership and `session.owner === this` are pointer compares, with no
  arm-aware equality.
- **Upcast is a C++ base conversion**, free and checked by clang. The
  `exactClassInstanceOf` / `implicitReceiver` / `classBoundReceiver` /
  construct-result opt-outs all disappear. Inside the template, `this` is
  always `Ref<G<T0>>`, a different C++ type from the slot's `Ref<G_erased>`,
  so there is nothing to disambiguate. Bug class C cannot recur.
- **The `any` case is expressible**, which a closed union is not.
- The dispatch cost for `T`-dependent members is the same identity test a
  tagged union's `is<i>()` switch pays. `T`-independent members get cheaper,
  because they need no dispatch at all.

`unknown` is a real instantiation (`G<gea::Value>` when something constructs
it) and never a licence to fold, so invariant 8 holds. A `G<number>` flowing
into a `G<unknown>` slot makes the slot a `class-family-ref` with both members.
Reads of `value` there produce `unknown`, the declared type. Covariance of
class arguments (`Box<Dog>` into a `Box<Animal>` slot) is a closed member list:
reading `value` converts each arm's `Ref<Dog>` to `Ref<Animal>` by upcast. No
boxing.

Genuinely heterogeneous unions (`UpdateOperation | DeleteOperation`, unrelated
classes) keep today's `tagged-union`. `class-family-ref` is specifically "one
generic root, several instantiations".

### (b) Overrides and virtual dispatch across generic hierarchies

C++ has no virtual member function templates. Two cases, split by the
storage/convention classification of §2.2:

**Convention parameters stay off the class** and become a closed set of
per-convention virtual slots. This is what `test/runtime/generic-override-copy-through-class-union-arm.runtime.ts`
already emits (§1.5), kept as the rule rather than an emergent outcome:

```cpp
struct gea_class_decl_f168_27 {                            // AbstractOperation: TResult is a convention parameter
  virtual void   gea_vcall_handleOk_void(gea::Ref<Reply>);  // slot per convention the family is called at
  virtual double gea_vcall_handleOk_num (gea::Ref<Reply>);
  virtual gea::Ref<gea::Dictionary<gea::Value>> gea_vcall_handleOk_doc(gea::Ref<Reply>);
};
template <gea::Carrier TResult>                            // the ONE body, a template over the convention parameter
TResult gea_body_fn_decl_f168_37(gea::Ref<gea_class_decl_f168_27> gea_this, gea::Ref<Reply> response);
// base slot definitions forward to the template:
inline gea::Ref<gea::Dictionary<gea::Value>> gea_class_decl_f168_27::gea_vcall_handleOk_doc(gea::Ref<Reply> r) {
  return gea_body_fn_decl_f168_37<gea::Ref<gea::Dictionary<gea::Value>>>(gea::Ref<gea_class_decl_f168_27>::adopt(this, true), r);
}
struct gea_class_decl_f168_97 final : gea_class_decl_f168_87 {   // CountOperation extends CommandOperation<number>
  double gea_vcall_handleOk_num(gea::Ref<Reply>) override;        // overrides exactly its convention's slot
};
```

- The slot set is enumerated per family: the union of conventions at which
  any call site in the family's subtree reaches the method. This is
  `overrideGroups` + `mintOverrideCopies`, but it mints **slots**, not bodies,
  so an override "missing at some base instantiation" (bug class D) becomes an
  unoverridden slot that inherits the base template's body. That is exactly
  JavaScript's semantics.
- A slot whose base body is dead (`as TResult` from a document into `number`)
  is the `dead-method-copies.ts` analysis, reduced to "this slot is pure in the
  base". Its instantiation is then never requested. C++ lazy instantiation
  does the rest: `gea_body_fn_decl_f168_37<double>` is never instantiated, so
  never certified, so never refused.
- The family's key is `(root, key, convention)`, computed from the call site's
  resolved ABI. It is never matched against installed methods afterwards.
  `methodCopyPreferenceOf`, `heldMethodCopyOf`, `publishedMethodCopyOf` and the
  "first copy" fallback are deleted, and with them bug class A. The site
  _names_ the slot.

**Storage parameters** are class template parameters, and C++ does the rest.
`D<U> : G<f(U)>`, a virtual declared in `G<T0>` with a `T0`-mentioning
convention, is overridden in `D<U>` at `f(U)`. C++ matches it because the base
is literally `G<f(U)>`. `ClassLayout.baseCopies`, `publishedBy`,
`classCopyFamiliesOf` and `classCopyHeritageOf` become unnecessary: the heritage
chain is spelled in the template's base clause (`heritageCopyOf` computes it
once, as today, but for a type expression rather than an ordinal).

Covariant overrides (an override returning a narrower class) keep today's
adapters (`virtualDispatchVerdictOf`'s protocol boundaries). C++ covariant
returns do not apply to `gea::Ref<>`.

A database driver's shape: `AbstractOperation<TResult>` has `TResult` convention-only, so
it is one struct with its per-convention slots (as today).
`AbstractCursor<TSchema>` has `TSchema` in storage, so it is a template with
`AbstractCursor_erased` holding `id`, `closed`, `killed`, the session, and the
`T`-independent method slots. `FindCursor<T>`,
`AggregationCursor<T>` and `RunCommandCursor` (at `any`, so
`AbstractCursor<gea::Value>` as its base) derive along single chains. Every
bare `AbstractCursor` slot is `Ref<AbstractCursor_erased>`.

### (c) Async and generator generic functions

Generators are C++20 coroutines today (`gea::Iterator<T, TReturn, TNext>`,
`emitYield` in `targets/cpp/emit.ts`, `promise_type` in `gea_runtime.h`
around :8551). Async bodies return `gea::Promise<V>` and complete
synchronously (`AwaitOperation` doc in `ir/model.ts`; `awaited()` reads the
settled value).

- A coroutine may be a function template. `std::coroutine_traits` is looked up
  per instantiation on the spelled return type (`gea::Iterator<T0, …>`), which
  is exactly what the emitter spells. Constraints that bind here: a coroutine
  cannot have a deduced (`auto`) return type or be `constexpr`. The emitter
  never uses either, so nothing changes.
- A frame's size is per instantiation. That is expected and matches today's
  copies.
- A `yield` of a `T`-typed value is a uniform op (`co_yield gea::exact<T0>(v)`).
  Aligning a yielded value to the cursor element is a conversion, so it is a
  dependent site when it mentions `T`.
- Async functions need nothing new while `await` stays synchronous. If `await`
  becomes a real suspension, `gea::Promise<V>` grows a `promise_type`, and the
  same "coroutine function template" rule applies.
- Generic closures (arrows inside a generic body) become lambdas inside the
  template. A lambda's type is dependent, which is fine because the compiler
  never names it. Captured `T0` values follow the usual `gea::exact` rule.

### (d) Certification and the no-boxing guarantee

- **Certification walks each template body once per instantiation**, with `σ`
  applied to every operand representation and each dependent site's resolved
  fragment substituted. The capability keys (`ir/certify.ts`, `certify/*`) are
  computed from `σ(representation)`, exactly the keys a copy would have
  demanded. A refusal names the instantiation (`Box<std::string>`), the site
  and the reason. The certificate lists `(generic, InstantiationKey)` pairs.
  The emitter's explicit instantiation definitions and trait specializations
  are generated **from the certificate**, so an uncertified instantiation has
  no trait specialization and fails in C++.
- **Guards** (`representation/verify.ts`) gain one rule: a `type-parameter`
  representation may appear only in an IR function that declares it, and
  every `σ` must close it. An open parameter outside its template, or a `σ`
  that leaves one open, fails closed. That is the successor of today's
  "reached representation without monomorphization". Every existing guard
  stays unchanged, applied per instantiation.
- **No-boxing** is checked per instantiation: `σ(T) = dynamic` only when the
  filling is `any`/`unknown` the program wrote or inferred and never narrowed
  (`declared-any-never-narrowed`), or under opt-in fallback. The boxing gate
  counts boxes per instantiation, so a template that boxes at one
  instantiation is not hidden by its others. Note
  `geatsc-boxing-gate-counted-only-the-top-level` applies: count inside
  carriers, not only the top.

### (e) The census and the flow proofs that type `any`

These stay. Generics meet them at three points:

1. **Fillings are refined before the key is computed.** A type argument the
   checker inferred as `any` from an `x as any` argument is refilled today by
   `erasedAnyFillingsOf`. The same refinement runs, but its output is the
   filling's carrier, so it feeds the `InstantiationKey`. If the flow proof
   types the argument (for example `Uint8Array`), the instantiation is
   `f<TypedArray<uint8>>`. Otherwise it is `f<gea::Value>` with
   `declared-any-never-narrowed`. There is no third option.
2. **`any`-instantiations are real instantiations** at the dynamic carrier,
   certified like any other. The difference is only that the dynamic reason is
   admissible there.
3. **Flow facts inside a generic body are per node, not per copy.** Today a
   fact about an `any` local inside a generic body is computed once per copy
   walk. With one walk it is the join over instantiations. For `T`-typed
   values that is irrelevant, because they have static type `T` and need no
   flow typing. For an `any`-typed local whose refinement differs per
   instantiation, the join may be less precise than a copy was. The fallback
   is sound (the join, or a refusal), never unsound. This is the one place the
   template model can lose precision relative to copies. Risk §6.4.

Census wildcards and reach-proof refusals (notes
`geatsc-census-wildcards-are-downstream-of-reach-refusals`,
`geatsc-every-stamp-is-the-unknown-callee-argument-stamp`) are keyed by site.
With one body per generic they get **fewer** sites, not different ones.

### (f) Structural identity and unsound casts

- **Two identical shapes are one type argument** because the key is
  `representationKey` of the filling's carrier, the same key `classGroupsOf`
  already uses. Two anonymous record types with one shape derive one record
  carrier and one C++ struct name. Two nominal interfaces with identical
  members derive whatever the representation layer says they derive. The
  template layer never has a second opinion.
- **Casts.** The user's policy is to trust declared types and treat a lying
  cast as the program's bug. Proposal:
  - An upcast, or a cast to an instantiation the static type already equals,
    is free.
  - An **explicit cast site** (`as`, `<T>x`, `as unknown as T`) that names a
    different instantiation of a class, or narrows a `class-family-ref` to one
    member, emits a **tag check** (`hasNativeClassLayoutRef<G<X>>`, already in
    the runtime) and throws `TypeError` on mismatch. This is memory safe and
    costs one compare at the cast, never at uses. This is the checked
    `receiverDowncastText` pattern (note `geatsc-any-copy-family-union`)
    generalized.
  - Inside a trusted declared type, no checks.
- **The reinterpretation case.** a database driver's `AbstractCursor.map` returns
  `this as unknown as AbstractCursor<T>`: one object, viewed at two
  instantiations, on purpose. A tag check there throws on every call, which
  breaks a real program the user wants compiled. The current rule
  (`noteReinterpretation` / `reinterpretedClasses` in `specialization.ts`: a
  class cast between its own instantiations through a top type is
  instantiated once at the top filling) maps directly. Such a class's storage
  parameters are fixed to their `any` carrier, so there is one instantiation
  and the cast is the identity. This is licensed because the program cast
  through a top type. **This is an open question for the user (§6.1).**

### (h) Specializing dynamic callees for the concrete argument (reflective walks)

**The case.** The application is fully typed: `db.collection<Todo>('todos')`,
`insertOne(todo)` with `todo: Todo`, `createdAt: Date`. The generic surface
(`Collection<TSchema>`) carries `Todo` faithfully, but it ends at the first
non-generic callee. The driver hands the document to bson's
`serialize(object: Document)`, where `Document` is `{ [key: string]: any }`,
and bson walks it reflectively:

```ts
for (const key of Object.keys(object)) {
  const value = object[key]          // static type: any
  if (typeof value === 'string') …
  else if (value instanceof Date) … value.getTime() …
  else if (Array.isArray(value)) …
  else if (typeof value === 'object') serializeInto(buffer, value, …)  // recursion
}
```

Today the `Todo` stays a native struct up to that call, but every `object[key]`
is a reflection read whose result is `any`. So each field comes out as a
`gea::Value`. The typed `Date` is boxed, `instanceof`-tested, unboxed and called.
Nothing is unsound, and after §3's `instanceof` unboxing nothing is slow per
operation either, but the box should not exist at all: at this call site the
compiler knows the exact carrier of `object`, its exact key list, and every
field's carrier.

**The proposal: an implicit type parameter.** A parameter whose declared type
is a top-like type (`any`, `unknown`, an index-signature record such as
`Document`, `object`), and which receives a statically known carrier at a call
site, is treated as if the callee had been written
`<P extends Declared>(object: P)`. The instantiation is the argument's carrier,
exactly as in §2.3 to §2.5, keyed by `representationKey`. From there it is
ordinary true-generics machinery, plus one new family of `P`-dependent
operations, the **reflective operations**, whose per-instantiation recipes are
compile-time folds:

| operation on a `P`-typed value                                                             | recipe when `P` is a known native struct                                                                          |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `Object.keys(o)` / `for…in` / `entries`                                                    | the struct's own-key list, in creation order, as a compile-time sequence                                          |
| `for (const k of Object.keys(o)) body`                                                     | **unrolled**: one copy of `body` per field, `k` a constant in each (C++ fold over the field list, `if constexpr`) |
| `o[k]` with `k` constant from that list                                                    | static member read; its carrier is the field's carrier, not `any`                                                 |
| `typeof v` / `v instanceof C` / `Array.isArray(v)` on such a read                          | folded to a constant; the dead branches are not emitted                                                           |
| a call passing such a read to another top-typed parameter (`serializeInto(buffer, value)`) | recursively instantiates that callee at the field's carrier                                                       |

For `Todo`, `serialize<Todo>` becomes straight-line code: write `title` as a
string, `done` as a bool, `createdAt` via `Date::getTime()`, recurse into
`serializeInto<Todo_meta>`, and loop `tags` as `Array<string>`. No box and no
string-keyed lookup.

**Soundness conditions.** These are all certification facts, checked per
instantiation. Any failure means that instantiation is not taken and the call
uses the dynamic instantiation `f<gea::Value>`, which exists today and stays
the fallback.

1. **Observable key order is preserved.** The unrolled sequence is the
   struct's creation-order key list (`NativeOwnKeyOrder`). If the struct can
   carry an expando sidecar (`noteNativeIndexKeyCreated`), the specialization
   appends a dynamic walk of the sidecar after the static fields. That is the
   same order `copyOwnPropertiesInCreationOrder` already produces.
2. **Absent optional fields** fold to the presence test the struct already
   has. An optional field unrolls to `if (present) body`, never to a read of
   `undefined` as a value.
3. **Accessors** on the struct (`RecordAccessor`) are read through [[Get]] in
   place, exactly as enumeration does today.
4. **Writes through `o[k]`** to a known field are static stores. A write to a
   key outside the struct goes to the sidecar, and if the struct has no
   sidecar the instantiation is refused.
5. **Termination.** Recursion reuses an instantiation already being built
   (same callee, same carrier), so a recursive record type yields one
   recursive C++ function, not an infinite unfolding. A value whose carrier is
   already `gea::Value` (a genuinely dynamic field) calls the dynamic
   instantiation.
6. **The declared type still bounds the argument.** The implicit parameter is
   `P extends Declared`; an argument that is not assignable is the checker's
   error, as today.

**When to specialize.** Not every function with an `any` parameter should be
cloned per argument type. The criterion is mechanical: the parameter's uses in
the callee are dominated by reflective operations that all fold for the
argument's carrier. A callee that stores the parameter into a heterogeneous
container, or hands it to a genuinely dynamic sink, gains nothing and keeps
the dynamic instantiation. Code size is bounded by the number of distinct
document carriers that reach the walk. For an application that is a handful
of schema types, each costing one straight-line serializer. §3(g)'s ICF note
applies.

**The read side.** bson's `deserialize` builds objects from bytes, which is
genuinely dynamic, and the driver returns them through an unchecked
`as WithId<TSchema>`. Today that is the checked adoption at the `as` site. The
symmetric extension is to instantiate the deserializer at the adoption target
(`deserialize<Todo>`), so that it parses straight into the struct, with the
dynamic path as the fallback when the bytes don't match the schema. That is a
schema-directed parser. It follows from the same mechanism: the adoption
target is the implicit type argument, and the reflective operations are the
writes `object[name] = value`. But it needs the "bytes don't match" case to
fall back rather than refuse, so it is listed as a follow-up in §6, not part
of the first cut.

**Why this belongs in this design rather than a separate optimization.**
Without true generics this would be a third copy-minting mechanism, with its
own keys, its own fold rules and its own dispatch problems: exactly the bug
classes §1.7 lists. With one IR body and templated emission, it is one more
source of instantiations and one more operation family in §2.7.

### (g) Code size and compile time versus today

- **Object code**: roughly equal. Clang instantiates exactly the functions
  certification listed, which is the same set of bodies today's copies emit,
  minus copies today's fold keeps apart but that share a carrier tuple. Linker
  ICF (`-Wl,--icf=all` with lld) folds identical instantiations; it cannot fold
  today's separately named copies any better.
- **Emitted C++ text**: smaller, in proportion to the generic share. The
  reflection hooks (about 170 lines per class struct in the excerpt above) and
  every uniform body are printed once. The HTTP framework: 201 of 607 bodies are inside
  generic copies but only about 28 are second copies, so the text saving there
  is modest. The database driver (`Collection` ×5, `AbstractCursor` 10 layouts) should see
  more. These are expectations; neither is to be claimed until measured once,
  at the end.
- **clang time**: template instantiation is cheap next to parsing. Explicit
  instantiation definitions plus `extern template` declarations pin each
  instantiation to one TU, so `--translation-units per-file|balanced` does not
  instantiate a body in every TU that sees it. Template definitions go into the
  shared prelude those TU modes already emit.
- **geatsc time**: the frontend no longer walks, maps, flows and lowers each
  generic body N times. That is the real saving, largest on the database driver. Note
  `geatsc-pairing-walk-warms-the-checker` warns that cutting frontend work can
  make compiles _slower_ through checker warm-up effects, so this is an
  expectation, not a claim.

## 4. What gets deleted

In the end state.

| file / function                                                                                                                                                                                                                                                           | fate                                                                                                                                  | lines (approx.) |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `specialization.ts`: `copiesMayDifferInLayout`, `canonicalLayoutFillings`, `canonicalOrdinalOf`, `baseCopiesDiffer`, `admittedUnder`, `specializationOfInstance`'s canonicalisation, `constructions`/`isConstructed`, `deferredSpellings`, the ordinal bookkeeping        | deleted. `unify`, `fromCall`, `fromTypeReference`, `fromValueUse`, the fixpoint and `erasedAnyFillingsOf` stay, emitting carrier keys | 2,689 → ~1,000  |
| `instantiation.ts`                                                                                                                                                                                                                                                        | deleted. Its constraint-default and sole-binding answers are the enumeration's `fromValueUse` rule                                    | 460             |
| `structural-generics.ts`                                                                                                                                                                                                                                                  | deleted. `σ` over representations replaces path substitution                                                                          | 198             |
| `structural-instantiated-member.ts`                                                                                                                                                                                                                                       | kept, repurposed to produce type-level traits (§2.5)                                                                                  | 0 (moves)       |
| `dead-method-copies.ts`                                                                                                                                                                                                                                                   | reduced to slot liveness                                                                                                              | 288 → ~100      |
| `identities.ts` `SpecializationPath` suffixing, `copyKeyOf`, `prefixFor`; `identity/ids.ts` `withoutSpecialization` and its dual-spelling consumers                                                                                                                       | deleted                                                                                                                               | ~250            |
| `census.ts` per-copy fork (:689)                                                                                                                                                                                                                                          | one walk                                                                                                                              | ~40             |
| `structural.ts`: `recordClassCopy`, `foldedCopyOf`, `copyOfClassInPath`, `classCopies`, reinterpretation fold, per-copy `mapperFor` keys                                                                                                                                  | deleted                                                                                                                               | ~600            |
| `representation/derive.ts`: `classGroupsOf`, `classArgumentKeyOf` (moves to the key), `physicalClassGroupOf`, `physicalCopyDeclarationOf`, `copyInstanceShapesOf`, `anyCopyFamilyOf`, `exactClassInstanceOf`, `copyFamilyUnions`, copy half of `classInstanceAncestorsOf` | deleted. `class-family-ref` derivation added (~150)                                                                                   | ~350            |
| `representation/publish.ts` `exactClassInstanceReadOf` and the `construct` exact-copy override; `SignatureShape.implicitReceiver`; `ReferenceOperation.classBoundReceiver`                                                                                                | deleted                                                                                                                               | ~200            |
| `projection/classes.ts`: `collapseSpecializations`, `mergedMethods` convention dedupe, `shareStaticSides`, `withBaseCopies`, `classLayoutOfCopy`, `sharedStaticOwnerOf`, `ClassLayout.copies/staticOwner/baseCopies`, `ClassMethod.publishedBy`                           | deleted. The static side becomes one layout by construction                                                                           | ~450            |
| `projection/dispatch.ts`: `classCopyFamiliesOf`, the convention partition in `virtualCopyFamiliesOf`, `copyAbsentFrom`, `methodCopyHeldBy`                                                                                                                                | replaced by `(root, key, convention)` slot families                                                                                   | ~300            |
| `ir/call-dispatch.ts` `methodCopyPreferenceOf`; `projection/fields.ts` `ClassMethodPreference`; `computed-method-value.ts` `heldMethodCopyOf`, `publishedMethodCopyOf`; `ir/lower.ts` `familyNamesClassCopy`; `ir/class-static-fields.ts` `staticOwner` routing           | deleted                                                                                                                               | ~300            |
| `semantics/class-heritage.ts` `classCopyHeritageOf`                                                                                                                                                                                                                       | replaced by the template base clause                                                                                                  | ~110            |
| producers (`shared.ts`, `invocations.ts`, `parameter-bindings.ts`, `return-bindings.ts`): per-copy view plumbing                                                                                                                                                          | reduced to dependent-site resolution                                                                                                  | ~1,000–2,000    |

Net deleted: about 2,300 lines of whole files, plus about 4,000–5,500 scattered
lines. Added: the `type-parameter`/`class-family-ref` representations, the
dependent-site resolution table, the template printer and the runtime concepts,
estimated at 2,500–3,500. The point is not the net count. The point is that the
five bug classes of §1.7 lose the decisions they lived in.

## 5. Migration plan

Old and new run **side by side in one `dist/`**, never a private build (see
`compiler/CLAUDE.md` "One compiler"). A compile option
`genericsModel: 'copies' | 'templates'` (CLI `--generics=templates`), and a
per-declaration eligibility predicate, decide which generics take the new path.
The default stays `copies` until the last slice. A generic that is not eligible
under `templates` falls back to copies, **per declaration**. That is legal
because the two paths share everything below the frontend except class/function
identity, and an ineligible generic keeps its ordinal ids.

Every slice passes:

1. `npx tsc -p tsconfig.json --noEmit` and `node scripts/architecture.mjs`.
2. **`npm run gate` on the default arm: byte-identical.** The default is still
   `copies`, so a slice that moves the default arm is a regression by
   definition, until the flip slice.
3. `npm run gate` on the `templates` arm, against a **second tracked baseline
   pair** (`scripts/emitted-baseline-*-templates.txt`, added in slice 1 via an
   `--generics=templates` pass-through in `scripts/emitted-gate.mjs`). Every
   moved program is named in the commit and explained. Expected movers are
   exactly the programs with an eligible generic.
4. The runtime tests for the named movers, one file at a time
   (`scripts/run-runtime-tests.mjs --only=…`), under both arms. The `expect:`
   lines are the equivalence proof, since the C++ differs by design.
5. From slice 3 on, once per slice: the HTTP framework build (the bare
   build of node-compat's HTTP framework test app with `scripts/build.mjs`)
   and the database driver probe (the command in the driver campaign note of
   2026-09-23), under `--generics=templates`.
   Compare the row set, not the count.

The slices:

**Slice 0: plumbing, no behaviour.** Add the `type-parameter` representation
and `InstantiationKey` (computed beside ordinals, published, and unused), plus
the option and the second gate baseline. Default gate: byte-identical.
Templates gate: byte-identical too, since nothing is eligible yet.

**Slice 1: generic classes with no cross-instantiation mixing, as class
templates.** Eligible: a generic class, not ambient, not nested in another
generic, with no generic base and no generic subclass, not reinterpreted,
whose every instance-typed slot the flow census proves holds exactly one
instantiation (so no `class-family-ref` is needed), and whose methods have no
dependent sites. Only uniform ops, no typeof on `T`. Emits the struct template,
the non-template static side, the construct and method function templates,
and explicit instantiation definitions. `generic-class-two-layouts.ts` is the
first mover. Its runtime `expect:` lines must hold unchanged. Candidates: the
`generic-*` runtime tests whose class has no heritage.

**Slice 2: the implicit-conversion guard in the runtime header.** Add
`gea::Carrier`, `gea::exact`, and `requires` on `Optional(U&&)` and `Promise`'s
converting constructors, keyed to an emitter-specialized
`InstalledWidening`. This moves the default arm only where the header text is
hashed. If the gate normalizes the header out, it must be byte-identical; if
not, the moved set is "every program" and the commit says so.

**Slice 3: generic functions as function templates** (including generic
methods on non-generic classes, and generic static methods), uniform ops only.
Generic callable values keep their existing single-instantiation rule and
become `CallableObject` wrappers over `&f<Args>`. `generic-function-set` becomes
a tag switch over `&f<Args_i>`.

**Slice 4: dependent sites and regions.** The resolution table, the fold rule,
trait emission, and verdict chains for `typeof`/`instanceof`/`in`. Movers: the
runtime tests with `typeof`/equality on `T`, and
`fixtures/generic-isarray-dead-branch.ts` (must stop lowering the dead branch).

**Slice 5: generic heritage chains with storage parameters.** `D<U> : G<f(U)>`
spelled in the base clause, and virtual slots in class templates.
`classCopyHeritageOf` and `baseCopies` become dead code on the templates arm.

**Slice 6: convention parameters and per-convention slots as the rule.**
Storage/convention classification. `AbstractOperation`-style families
enumerate slots instead of bodies. `dead-method-copies` becomes slot
liveness. Movers must include `generic-override-copy-through-class-union-arm.runtime.ts`,
`generic-method-override-minted-at-every-base-copy.runtime.ts` and
`overridden-generic-method-copies-dispatch-per-copy.runtime.ts`.

**Slice 7: `class-family-ref` and erased bases.** The mixed-instantiation
slots, closed and open. Movers: `generic-split-copy-into-its-any-copy.runtime.ts`,
`split-copy-this-listener-into-emitter-slot.runtime.ts`,
`generic-class-at-a-top-type-and-a-concrete-type.ts`, and the database driver's cursor
family. Checked casts at explicit cast sites land here.

**Slice 8: flip the default.** Take one full runtime run (the landing gate for a
default flip, once), plus the HTTP framework build and the database driver probe. Retake both gate
baselines in the same commit. Name the moved set: every program with a
generic.

**Slice 9: delete the copy path** (§4). Default gate: byte-identical to slice
8's baseline. The deletion must move nothing.

Rollback at any slice is the option. Nothing is deleted before slice 9.

## 6. Open questions and risks

Questions that need the user's call:

1. **Reinterpretation casts** (`this as unknown as AbstractCursor<T>`). Keep the
   current rule (such a class is instantiated once at its top filling, and the
   cast is the identity)? Or apply the stated cast policy strictly (tag check,
   `TypeError`), which breaks a database driver's `cursor.map()`? This note proposes
   keeping the rule, because the program cast through a top type.
2. **Writes through a covariant slot** (`Box<unknown>` slot holding a
   `Box<number>`, assigned a string). JavaScript stores the string. The
   proposal throws `TypeError` from the checked per-member store. It is memory
   safe but diverges from JavaScript for a program TypeScript accepts. Is that
   acceptable under "a lying type is the program's bug", given that here
   TypeScript's own covariance is what lied?
3. **Convention parameters stay erased from the class.** This means
   `AbstractOperation<void>` and `AbstractOperation<number>` are one C++ struct,
   which is what today emits. Confirm that `instanceof`/identity semantics
   never need to tell them apart. JavaScript cannot tell them apart, so this
   should be safe.
4. **Default flip and fallback**: are per-declaration fallback to copies
   during slices 1–7 and one flip in slice 8 acceptable? Or should the flip
   require zero ineligible generics in the corpus?
5. **`Optional`/`Promise` converting constructors** (slice 2) are runtime
   header changes that affect non-generic code. Land them first, as an
   independent hardening, or only for template TUs?
6. **Schema-directed deserialization** (§3(h), read side). The first cut
   specializes only walks over a value whose carrier is known: serialization,
   copying, JSON writing. Instantiating a byte-level parser at an adoption
   target (`deserialize<Todo>`) needs a defined fallback when the bytes do not
   match the schema: fall back to the dynamic parse plus the checked adoption,
   never refuse. Is that fallback acceptable as the semantics, and should it
   land together with the write side or after it?

Risks:

1. **Dependent-site coverage.** Producers make many decisions from operand
   types. Every one that can see a type parameter has to be expressible as a
   per-site resolution. A producer that consults the _enclosing_ body's state
   (for example a binding's merged carrier across branches) cannot be resolved
   site-locally. Such bodies stay ineligible, and slice 4 has to measure how
   many there are before committing to the end state.
2. **Two authorities during migration.** Copies and templates coexisting is
   exactly the "two authorities" shape. The mitigation is the per-declaration
   partition. A generic is on one path, whole, and the eligibility predicate is
   the single authority on which path.
3. **Heritage-induced instantiations have no checker spelling** (note
   `geatsc-copy-members-need-the-instantiated-spelling`: a measured dead end).
   Type-level traits for a base instantiated only through `extends` must come
   from the derived class's own instantiated spelling, or the site stays
   ineligible. They must never come from `getBaseTypes`.
4. **Flow precision** (§3e): one join across instantiations instead of
   per-copy facts for `any`-typed locals inside generic bodies. It is sound but
   may turn a typed read into a refusal. Slice 4's mover list will show it.
5. **C++ template error surfaces.** A certification defect now surfaces as a
   clang template error at a trait with no specialization. That is correct
   (fail closed) but harder to read. The certificate must carry a mapping from
   trait names to sites for the diagnostic sweep.
6. **clang build time for large instantiation sets** (a database driver). Explicit
   instantiation plus `extern template` should keep it at today's level. This
   is unmeasured.
7. **The gate's normalization** hashes emitted C++ after normalizing SSA
   numbering. Template text needs the same treatment for trait and slot names
   (`gea_dep_…_dN`, convention hashes), or every unrelated change reorders them.
   Slice 0 must add that normalization, or the templates-arm baseline will be
   noise.
