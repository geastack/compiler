import type { DeclarationId, FunctionId, OperationId, RegionId, StructuralTypeId } from '../../identity/ids.js'
import type { SemanticOperationBase } from './operands.js'
import type { InvocationResultDivergence, SelectedSignature } from './selected-signature.js'
import type { HostMethodBinding } from '../host-methods.js'

/**
 * The declared storage a value operand enters.
 *
 * An operation's result is often unrelated to where one of its operands is
 * stored: an invocation returns its callee's result, an array literal returns
 * the array, and a property definition returns its receiver.  A conversion
 * census must therefore not try to recover the destination from that result.
 * The producer that owns the language operation publishes the exact slot type
 * instead. `type` retains the complete structural identity so the later
 * stored-position derivation selects the same ownership and `void` storage
 * carrier as the ABI, record, or tuple slot.
 */
export interface ConversionRoleTarget {
  readonly role: string
  readonly ordinal: number
  readonly owner: 'parameter-slot' | 'array-element' | 'declared-field'
  readonly type: StructuralTypeId
}

/**
 * The normalized operation union.
 *
 * These are ECMAScript operations, not source shapes. `C.m()`, `const f = C.m;
 * f()`, and `(0, C.m)()` differ in their operations and edges because they
 * differ in JavaScript, not because they differ in spelling. Conversely two
 * spellings of one operation must produce one member of this union.
 *
 * Nothing here names a framework, a helper, a fixture, or an application. A
 * discriminant such as `proxy-wrap` or `direct-map` would be a source shape
 * promoted to semantics, which is the defect this union exists to prevent.
 */

/** ECMAScript Reference: the thing `GetValue` and `PutValue` operate on. */
export interface ReferenceOperation extends SemanticOperationBase {
  readonly family: 'reference'
  /**
   * `this` is the one form that publishes a `value` result rather than a
   * `reference` one. `ResolveThisBinding` returns the value itself -- there is
   * no Reference Record to take `GetValue` of, and no way to assign through it
   * -- so a consumer cites its value directly instead of the read that every
   * other form needs.
   *
   * `parameter-value` is the same shape for a different reason: it is the raw
   * value the caller's frame supplied for one argument slot, *before*
   * `FunctionDeclarationInstantiation`'s default-value semantics run over it
   * (ECMA-262 9.2.10). Nothing in the language lets a program read or assign
   * this exact value a second way -- the named binding a default parameter
   * introduces is a later, separate value (`binding` family, citing the
   * `destructuring` family's `default-value` step) -- so this form exists only
   * so the raw argument can be a guard's own citable result, the same way an
   * `if` condition or a `??` left side already is.
   */
  readonly form: 'identifier' | 'property' | 'super-property' | 'private-name' | 'this' | 'parameter-value' | 'global-this'
  readonly strict: boolean
  /** Reference resolution can throw before any value is produced. */
  readonly unresolvableThrows: boolean
  /**
   * An `identifier` form naming no symbol anywhere in the program -- ECMA-262
   * 6.2.5.6 `ResolveBinding` finds no environment record for it. A NAME fact,
   * not a behavior one: it is what makes `buildReference`
   * (`producers/references.ts`) publish this operation's `value` result
   * directly (there is no cell a `binding` read could ever be minted
   * against), independent of whether reading it actually throws.
   *
   * `unresolvableThrows` is the behavior that USUALLY follows from this --
   * `GetValue` throws before a Reference Record's usual read would even apply
   * -- except for `typeof`, whose ECMA-262 13.5.1.2 carve-out returns
   * `"undefined"` for exactly this shape without ever calling `GetValue`.
   * `ir/lower.ts` needs both facts kept apart: `hasNoCell` says whether a
   * `value` result exists to lower here at all (the same `binding`-read gap
   * `unresolvableThrows`'s own citation-side comment explains), and
   * `unresolvableThrows` says whether that lowering is a throw or the
   * constant `undefined` the `typeof` exemption produces instead.
   */
  readonly hasNoCell: boolean
}

/**
 * Object internal methods.
 *
 * This is the single property spine. There is no second route from a property
 * expression to a runtime operation: records, arrays, maps, class instances,
 * host objects, and proxies all implement these same internal methods over
 * their own native carriers.
 */
export interface PropertyOperation extends SemanticOperationBase {
  /** The checker-resolved ambient member's implementation, independent of the receiver's storage layout. */
  readonly hostMethod?: HostMethodBinding
  /**
   * The finite set of property-name texts a COMPUTED key can evaluate to,
   * proven closed forward from every closed caller
   * (`normalize/flow/computed-key-set.ts`) and checked against the sealed
   * host-mutation census's own obligations
   * (`ProducerContext.computedKeyTextsOf`). Absent for a static key -- it
   * would be redundant with the key operand's own constant text -- and absent
   * whenever the proof refused or one of its intrinsic assumptions did not
   * survive the final census: this is an UPPER bound on an otherwise-unknown
   * key, never evidence to invent where none was proven.
   *
   * Only askable here, while the semantic graph is still open: the key set is
   * a fact about the checked PROGRAM (which callers can reach this write with
   * which options literal), not about the emitted C++, where the key has
   * already become an opaque `std::string` and the question can no longer be
   * asked. `ir/lower-property.ts` copies it onto the IR `get`/`set` operation
   * for exactly that reason -- see `GetOperation.provenKeyTexts` there.
   */
  readonly provenKeyTexts?: readonly string[]
  /**
   * The existing cell a read through an ESM namespace object or the intrinsic
   * global object names.
   *
   * `import * as ns from './m'; ns.x` performs a namespace `[[Get]]`, but its
   * answer is the live value of `m`'s exported binding `x`. Keeping that
   * declaration identity lets lowering read the exporting cell directly;
   * materializing a second object would lose the live-binding semantics. An
   * authenticated `globalThis.process` likewise names the same host singleton
   * binding as bare `process`, never a boxed copy in the expando dictionary.
   */
  readonly resolvedBinding?: DeclarationId
  /** The optional-chain guard is proven present and the expression result is the same value as this read. */
  readonly shortCircuitAlwaysPresent?: true
  /** This resolved binding came through the intrinsic global object rather than an ESM namespace. */
  readonly resolvedGlobalBinding?: true
  /** This read produces the authenticated global Function.prototype object. */
  readonly intrinsicValue?: 'function-prototype'
  readonly family: 'property'
  readonly internalMethod: 'get' | 'set' | 'delete' | 'has-property' | 'own-property-keys' | 'define-own-property'
  /** `PutValue` throws when this `[[Set]]` answers false in strict code. */
  readonly strict: boolean
  /**
   * Whether the key required a `ToPropertyKey` conversion at runtime. A static
   * key is an optimization opportunity; it is not a different operation.
   */
  readonly keyIsComputed: boolean
  /** Normal completion is known to return absence; receiver evaluation may still throw. */
  readonly normalResult?: 'undefined'
  /**
   * The attributes `define-own-property` installs. `[[Set]]` and `[[Get]]` do
   * not carry one -- they consult whatever descriptor is already there -- so
   * this is `null` for every method but `define-own-property`, where it is
   * mandatory: a definition with no stated attributes is not a weaker
   * definition, it is an unanswerable question.
   */
  readonly descriptor: PropertyDescriptorShape | null
}

/** Binding cells: the lexical environment as an explicit value, not an emitter detail. */
export interface BindingOperation extends SemanticOperationBase {
  readonly family: 'binding'
  readonly action: 'initialize' | 'read' | 'write' | 'declare'
  readonly declaration: DeclarationId
  readonly mutable: boolean
  /** A read before initialization is a TDZ throw, which is observable behavior. */
  readonly temporalDeadZone: boolean
  /** This initializes a formal parameter before the enclosing body's declarations and statements. */
  readonly parameterInitialization?: boolean
  /** This initializes a direct body-level function declaration during FunctionDeclarationInstantiation. */
  readonly hoistedFunctionInitialization?: boolean
  /**
   * Set only on the 'declare' introduction of an ambient value declaration: a
   * cell this program names but never writes, because a host supplies the
   * value from outside it. `linkageName` is the ABI contract with that host,
   * spelled exactly as the declaration names it -- the one place in this
   * compiler a declaration's own text is authoritative, the same way a C++
   * `extern` declaration's own spelling is the contract it makes with a
   * definition elsewhere. Every other introduction leaves this unset;
   * `projectBindingPlacements` (projection/bindings.ts) is the only reader,
   * and it is what turns this introduction into `BindingStorage.kind ===
   * 'external'` instead of an ordinary run-once-region global that nothing in
   * the program ever assigns.
   */
  readonly external?: { readonly linkageName: string }
  /** A checker-authenticated CommonJS wrapper binding, scoped to its source module. */
  readonly commonJs?: {
    readonly global: 'require' | 'exports' | 'module'
    readonly owner: RegionId
    /** This read belongs to a source-proven exact native module record, not merely a matching ambient shape. */
    readonly nativeRecord?: true
  }
}

/** Evaluated `[[Call]]` and `[[Construct]]`, plus tagged-template application. */
export interface InvocationOperation extends SemanticOperationBase {
  readonly family: 'invocation'
  readonly internalMethod: 'call' | 'construct'
  readonly optionalChain: boolean
  readonly selectedSignature: SelectedSignature | null
  readonly resultDivergence: InvocationResultDivergence
  readonly target: SemanticTargetProof
  /**
   * A checker-authenticated, statically resolved CommonJS require.  The
   * module identities, not the specifier text, are the runtime route.
   */
  readonly commonJsRequire?: {
    readonly owner: RegionId
    readonly target: RegionId
    readonly builtinModule: string | null
    /** The target source proved one exact native exports carrier. */
    readonly nativeRecord?: true
  }
  /** A literal host builtin lookup whose ModuleRecord must be retained. */
  readonly builtinModuleLookup?: { readonly target: RegionId; readonly builtinModule: string }
  /** A checker-authenticated intrinsic that mutates its first argument. */
  readonly intrinsicMutation?: 'object-assign' | 'reflect-set' | 'object-define-property' | 'object-define-properties'
  /** A checker-authenticated intrinsic that only queries its first argument's own keys. */
  readonly intrinsicOwnKeys?: true
  /** Authenticated Reflect operation: a native ABI still observes this property protocol. */
  readonly intrinsicReflection?: 'get' | 'set' | 'has' | 'deleteProperty' | 'getOwnPropertyDescriptor'
  /** Unmodified standard Object.defineProperty, authenticated by the host mutation census. */
  readonly intrinsicDataDefinition?: true
  /**
   * A checker-authenticated intrinsic whose whole answer is its argument's
   * CARRIER: `Array.isArray(v)`, ECMA-262 23.1.2.2, which asks whether the
   * value is an Array exotic object and reads nothing else -- no property, no
   * getter, no method. The sibling of `intrinsicOwnKeys`, and authenticated by
   * the same rule.
   */
  readonly intrinsicCarrierPredicate?: true
}

/** A runtime target an invocation can reach. */
export type SemanticRuntimeTarget =
  | {
      readonly kind: 'function'
      readonly functionId: FunctionId
      /** Whether the source creates an ordinary ECMAScript function object with [[Construct]], rather than an arrow, method, async function, or generator. */
      readonly constructable: boolean
      /**
       * The generic source function this target is a copy of, when the call
       * dispatches over a `generic-function-set` callee: the set's tag
       * indexes its members by this id, and this is what pairs the target
       * with the arm it runs for.
       */
      readonly member?: DeclarationId
    }
  /**
   * A class with no written constructor has no source function to identify.
   * Fabricating a `FunctionId` for it would invent authority, so the union
   * preserves the absence instead.
   */
  | { readonly kind: 'implicit-source-constructor'; readonly classDeclaration: DeclarationId }

/**
 * What the compiler can prove about the runtime target set.
 *
 * `open` is a complete, correct answer: it selects the generic call path. It is
 * not a failure, and it must never be repaired by guessing from callee syntax.
 *
 * @semanticCategory generic-primitive
 */
export type SemanticTargetProof =
  | { readonly kind: 'exact'; readonly target: SemanticRuntimeTarget; readonly evidence: readonly string[] }
  | { readonly kind: 'closed-family'; readonly targets: readonly SemanticRuntimeTarget[]; readonly evidence: readonly string[] }
  | { readonly kind: 'open'; readonly evidence: readonly string[] }

/**
 * The allocation kinds that create a fresh object identity -- and the one that
 * deliberately does not.
 *
 * `'template-object'` is the exception, and it is an exception the language
 * itself makes: ECMA-262 13.2.8.3 `GetTemplateObject` caches its result per
 * Parse Node, so a tagged template hands the *same* object to its tag on every
 * evaluation of that site. It is an allocation in this family because it is
 * where the object comes from; what it is not is a fresh identity per
 * evaluation, and every consumer that reads this kind has to honour that.
 */
export interface AllocationOperation extends SemanticOperationBase {
  readonly family: 'allocation'
  readonly allocated:
    | 'object-literal'
    | 'array-literal'
    | 'function-object'
    | 'class-constructor-object'
    | 'regexp-object'
    | 'construction-result'
    | 'template-object'
  readonly shape: StructuralTypeId
  /** A direct body-level function declaration allocated before executable body statements. */
  readonly hoistedFunctionInitialization?: boolean
  /**
   * The source function a `function-object` allocation makes a callable for,
   * and `null` for every other allocated kind.
   *
   * The shape cannot answer this. Structural types intern by structure, so two
   * unrelated functions with the same signature share one `signature` shape --
   * allocating a closure for `f` and one for `g` would then be the same
   * operation. The identity has to be carried, not recovered.
   */
  readonly callable: FunctionId | null
  /** [[SourceText]] for a source-defined callable; absent for runtime-created allocations. */
  readonly functionSource?: string
  /**
   * `[[Name]]` for a source-defined callable -- its own declared name, or the
   * `NamedEvaluation` name from where an anonymous function/arrow expression
   * was defined, or `''` when neither applies. Absent alongside
   * `functionSource` for every non-callable allocation.
   */
  readonly functionName?: string
  /** `Function.prototype.length` for a source-defined callable: the written parameters before the first default/rest one. */
  readonly functionLength?: number
  /**
   * Whether the source-defined callable is a `function*` / `async function*`
   * -- a fact of the DECLARATION, carried because nothing downstream can
   * recover it: the callable's type is `Generator<...>` whether the body is a
   * generator or an ordinary function that returns one it obtained elsewhere,
   * so a consumer keying on the result carrier confuses the two. Present under
   * the same condition as `functionSource`.
   */
  readonly generatorFunction?: boolean
  /**
   * Whether the declaration performs ECMA-262 10.2.5 `MakeConstructor` and so
   * owns a `prototype` object -- true for an ordinary `function` declaration
   * or expression, false for an arrow, a method, an accessor and an `async
   * function`, and ABSENT for a generator, whose `prototype` exists but
   * inherits `%GeneratorFunction.prototype.prototype%` this runtime does not
   * model.
   *
   * Carried for the same reason `generatorFunction` is: the CARRIER cannot
   * answer it. `function-and-constructor` owns a prototype and
   * `function-value-dispatch` was read as owning none, which made one
   * authority -- whether the checker gave the value a construct signature --
   * answer two different questions: how the value is invoked, and whether the
   * declaration behind it has a `prototype`. An ordinary `function` asserted
   * call-only is exactly where the two answers differ.
   *
   * The absent third state is deliberate: an unanswered read fails closed at
   * certification rather than reporting `undefined` for a property that
   * exists.
   */
  readonly ownPrototypeProperty?: boolean
  /**
   * For a `class-constructor-object` allocation, the class whose constructor
   * object this is. A memberless class expression publishes no
   * `class-lifecycle` event at all, so without this the graph could not say
   * the class was evaluated, and its `[[Name]]` (`functionName`, the same
   * field a function allocation fills) would have no class to attach to.
   */
  readonly classDeclaration?: DeclarationId
  /** The class whose written constructor body this function allocation implements. */
  readonly classConstructorBodyOf?: DeclarationId
}

/** The one role target an operation published, if this producer owns one. */
export const conversionRoleTargetOf = (
  operation: SemanticOperationBase,
  role: string,
  ordinal: number,
  owner: ConversionRoleTarget['owner']
): ConversionRoleTarget | undefined =>
  operation.conversionRoles?.find((target) => target.role === role && target.ordinal === ordinal && target.owner === owner)

/** Class definition and instance lifecycle events. */
export interface ClassLifecycleOperation extends SemanticOperationBase {
  readonly family: 'class-lifecycle'
  readonly event:
    | 'evaluate-heritage'
    | 'define-method'
    // A getter and a setter install different internal slots -- `[[Get]]` and
    // `[[Set]]` of one accessor descriptor -- and a consumer that has to act on
    // one of them cannot read which it has from a single `define-accessor`.
    // Naming them apart is what makes that answerable without re-deriving it
    // from the installed function's arity.
    | 'define-getter'
    | 'define-setter'
    | 'define-field'
    | 'run-static-block'
    | 'install-private-brand'
    | 'bind-class-value'
    // `Object.setPrototypeOf(C.prototype, B.prototype)`, modelled as `C`
    // inheriting from `B` (`semantics/prototype-reparenting.ts`). Published
    // where the call runs, with the `constructor` and `heritage` class values.
    | 'reparent-prototype'
  readonly declaration: DeclarationId
  /**
   * The class whose evaluation this event belongs to.
   *
   * `declaration` names the member, which is what the event acts on; without
   * the class as well, a consumer assembling a class's layout would have to
   * recover it by walking syntax, and the walk and the graph would then be two
   * authorities over which members a class has.
   */
  readonly classDeclaration: DeclarationId
  /**
   * The descriptor a prototype installation publishes. Runtime `[[Get]]` stays
   * authoritative for the value a call site selects; this records what was
   * installed, so deletion, replacement, and revocation can win over it.
   */
  readonly descriptor: PropertyDescriptorShape | null
  /**
   * Where a `define-*` event installs its member: on each instance (`own`),
   * on the prototype, or on the constructor (`static`). `null` for every
   * event that installs no member.
   *
   * A fact of the event, not of the descriptor: a private element has no
   * property descriptor at all (no `[[DefineOwnProperty]]` happens for it),
   * and while placement rode on the descriptor a `static #m()` had nowhere to
   * say it was static -- `projection/classes.ts` would have filed it among the
   * instance members, so the producer refused every static private member
   * instead. Placement here is what lets a private member be static.
   */
  readonly placement: 'own' | 'prototype' | 'static' | null
  /** True only for a field synthesized onto an ancestor by the subclass-member overlay. */
  readonly syntheticSubclassMemberOverlay?: boolean
  /** A layout demand, not evaluation or allocation of this class's constructor. */
  readonly classLayoutOnly?: boolean
}

/** A property descriptor as the language defines it. */
export interface PropertyDescriptorShape {
  readonly writable: boolean
  readonly enumerable: boolean
  readonly configurable: boolean
}

/** Operators and coercions. */
export interface ComputationOperation extends SemanticOperationBase {
  readonly family: 'computation'
  readonly form:
    | 'unary'
    | 'binary'
    | 'logical'
    | 'assignment'
    | 'update'
    | 'conditional'
    | 'template'
    | 'comma'
    | 'coercion'
    | 'equality'
    | 'typeof'
    | 'instanceof'
    | 'in'
  /** The exact operator token, as a language operator, not as source text. */
  readonly operator: string
}

/**
 * Control effects: the CFG as explicit operations rather than emitter structure.
 *
 * `'loop'` is head-tested -- the condition decides whether the body runs at
 * all, so the body sits on the truthy side of that decision. `'loop-tail'` is
 * the other order, which `do`/`while` is the only spelling of: the body runs
 * first and unconditionally, and the condition decides only whether to run it
 * *again*. That is a different block shape, not a different rendering of one
 * shape, so it is a distinct form rather than a flag -- a consumer that treats
 * a tail-tested loop as head-tested skips the guaranteed first iteration, and
 * a consumer that treats a head-tested one as tail-tested runs a body the
 * source program never enters.
 */
export interface ControlOperation extends SemanticOperationBase {
  readonly family: 'control'
  readonly form:
    | 'branch'
    | 'loop'
    | 'loop-tail'
    | 'switch'
    | 'return'
    | 'throw'
    | 'try'
    | 'label'
    | 'break'
    | 'continue'
    | 'await'
    | 'yield'
    | 'debugger'
  /** The cleanup protocol operation owned by a synchronous dynamic `for`-`of` loop. */
  readonly iteratorClose?: OperationId | null
}

/**
 * Iterator, spread, enumeration, and disposal protocols.
 *
 * A `protocol: 'spread'` operation (object spread's `CopyDataProperties`,
 * `producers/protocol.ts`'s `contributeObjectSpread`) carries a `source`
 * operand (the value being spread) and a `receiver` operand (`{ kind:
 * 'provenance' }`, naming the object literal it copies into -- the same
 * identity `producers/allocations.ts`'s `AllocationOperation` for that
 * literal already publishes, cited rather than re-minted). `ir/lower-protocol.ts`
 * needs both: the source to walk and the receiver to write into.
 */
export interface ProtocolOperation extends SemanticOperationBase {
  readonly family: 'protocol'
  readonly protocol: 'iterator' | 'async-iterator' | 'spread' | 'enumerate' | 'dispose' | 'async-dispose'
  readonly step: 'get-method' | 'get-iterator' | 'next' | 'close' | 'return' | 'throw'
}

/** Exception regions, labelled targets, and generator/async resume channels. */
export interface BoundaryOperation extends SemanticOperationBase {
  readonly family: 'boundary'
  readonly boundary: 'exception-region' | 'finally-region' | 'label-target' | 'generator-resume' | 'async-resume'
}

/** Declaration order, module links, initializer flow, resource disposal. */
export interface DeclarationLifecycleOperation extends SemanticOperationBase {
  readonly family: 'declaration-lifecycle'
  readonly event: 'hoist' | 'module-link' | 'module-evaluate' | 'initialize' | 'dispose'
  readonly declaration: DeclarationId
}

/** Destructuring, modelled as its constituent reads, writes, and defaults. */
export interface DestructuringOperation extends SemanticOperationBase {
  readonly family: 'destructuring'
  readonly form: 'object-source' | 'object-pattern' | 'array-pattern' | 'array-pattern-close' | 'rest-element' | 'default-value'
}

/**
 * JSX element construction.
 *
 * JSX is a language surface with no meaning of its own: what `<div id="x">y</div>`
 * constructs is decided entirely by the declarations the checked program's JSX
 * namespace supplies. So this operation states the *shape* of the construction --
 * a tag, a props object, an ordered child list -- and nothing about what the
 * result is or how it renders, which is the framework's answer to give.
 *
 * Props are one operand, not many, because JSX props are an object literal in
 * the language's own terms: `<div a={x} b={y}/>` evaluates `{a: x, b: y}` and
 * hands it over whole. Modelling each attribute as its own operand here would
 * be a second, weaker copy of the record machinery that already exists, and the
 * two would eventually disagree about evaluation order.
 */
export interface ElementOperation extends SemanticOperationBase {
  readonly family: 'element'
  /**
   * `intrinsic` names a tag the JSX namespace declares; `value` names a value
   * the program declared; `fragment` groups children with no tag at all. They
   * are three different constructions and nothing downstream may collapse
   * them: an intrinsic tag is data, and a value tag is whatever the library
   * that declared it says it is -- which is why this compiler answers only the
   * first and leaves the other two to whoever installed the library.
   */
  readonly form: 'intrinsic' | 'value' | 'fragment'
  /**
   * The property a component's props object carries its children under, as the
   * program's own `JSX.ElementChildrenAttribute` declares it, or `null` when
   * the JSX namespace declares none.
   *
   * This is the one spelling in this operation that comes from a declaration,
   * and it is admissible for the same reason an ambient declaration's linkage
   * name is: the JSX namespace states it *as data* -- the whole purpose of
   * `ElementChildrenAttribute` is to name the key -- so reading it is consuming
   * the language's own answer, not inferring one from source shape. Hard-coding
   * `children` here would be the compiler answering a question the checked
   * program is entitled to answer differently.
   */
  readonly childrenKey: string | null
}

/** Dynamic import and direct eval: open runtime semantics, stated explicitly. */
export interface DynamicLanguageOperation extends SemanticOperationBase {
  readonly family: 'dynamic-language'
  readonly form: 'dynamic-import' | 'direct-eval'
}

export type SemanticOperation =
  | ReferenceOperation
  | PropertyOperation
  | BindingOperation
  | InvocationOperation
  | AllocationOperation
  | ClassLifecycleOperation
  | ComputationOperation
  | ControlOperation
  | ProtocolOperation
  | ElementOperation
  | BoundaryOperation
  | DeclarationLifecycleOperation
  | DestructuringOperation
  | DynamicLanguageOperation
