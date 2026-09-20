import ts from 'typescript'
import type { DeclarationId, StructuralTypeId } from '../../identity/ids.js'
import type { SignatureParameter } from './structural-types.js'

/**
 * The signature TypeScript selected for an invocation.
 *
 * This is checker resolution, not runtime target proof. It says which
 * declaration the checker picked; it does not claim that declaration is the
 * complete set of functions that can run. That claim is a separate attachment
 * so that a monkey-patched, shadowed, or reassigned callee cannot inherit the
 * checker's confidence.
 */

/**
 * Where a generic instantiation came from.
 *
 * The public checker API exposes the type arguments a call site wrote, but not
 * the mapper it inferred. `inferred` therefore records that substitutions exist
 * and are unavailable. A consumer that needs instantiated parameter types must
 * fail closed on it -- re-deriving substitutions from argument expressions,
 * callee spelling, or declaration display names is exactly the rediscovery this
 * layer exists to prevent.
 */
export type TypeArgumentProvenance =
  | { readonly kind: 'none' }
  | { readonly kind: 'explicit'; readonly arguments: readonly ExplicitTypeArgument[] }
  | { readonly kind: 'inferred'; readonly reason: 'checker-mapper-not-public' }

/** One written type argument, paired with the parameter it instantiates. */
export interface ExplicitTypeArgument {
  readonly parameter: DeclarationId
  readonly argument: StructuralTypeId
}

/** Whether the selected declaration is real source or an ambient declaration. */
export type SignatureProvenance = 'source' | 'ambient'

export interface SelectedSignature {
  /** The declaration the checker selected. Identity, never a display name. */
  readonly declaration: DeclarationId
  readonly provenance: SignatureProvenance
  /**
   * Runtime parameter shape. An explicit `this` parameter is authenticated
   * separately and excluded here, because it is a type-system device rather
   * than an argument the call site passes.
   */
  readonly parameters: readonly SignatureParameter[]
  readonly minimumArity: number
  readonly thisParameter: StructuralTypeId | null
  readonly typeArguments: TypeArgumentProvenance
  /** The instantiated structural return type of the selected signature. */
  readonly returnType: StructuralTypeId
}

/**
 * Why an invocation's result type may differ from its selected signature's
 * return type.
 *
 * Every reason is listed here. Anything else disagreeing is a defect, and
 * the check below is what turns that defect into a failure instead of letting a
 * consumer silently pick whichever type it prefers.
 */
export type InvocationResultDivergence =
  /** `a?.b()` adds the short-circuit `undefined` path to the call result. */
  | { readonly kind: 'optional-call-short-circuit' }
  /** `super()` evaluates to `void`, not to the base constructor's instance type. */
  | { readonly kind: 'super-constructor-initialization' }
  /**
   * `JSON.parse(text) as T`: the call's own declared return type is `any`
   * (`lib.es5.d.ts`), and the caller's own assertion is what names the real,
   * physical type this backend renders `JSON.parse` as returning
   * (`targets/cpp/emit-json.ts`'s `jsonCallText` — this compiler controls and
   * renders `JSON.parse`'s own implementation, which is what makes
   * substituting the caller's asserted type safe here and nowhere else; see
   * `producers/invocations.ts`'s `jsonParseResultOverride`).
   */
  | { readonly kind: 'json-parse-type-assertion' }
  /**
   * `new Array(n)`: the constructor's own declared return type is `any[]`
   * (`lib.es5.d.ts`'s `ArrayConstructor` has no generic parameter for a
   * contextual type to narrow), and the enclosing `as T[]` assertion or the
   * variable/field declaration this construction directly initializes is
   * what names the real, physical element type this backend allocates
   * (`targets/cpp/emit-callable.ts`'s `emitArrayConstruct` -- this compiler
   * controls and renders `new Array(n)`'s own implementation, which is what
   * makes substituting the declared element type safe here and nowhere else;
   * see `producers/invocations.ts`'s `arrayConstructResultOverride`).
   */
  | { readonly kind: 'array-construct-type-annotation' }
  /**
   * `new RangeError(m) as RangeError & { code: string }`: the constructor's
   * own declared return type is the plain error interface, and the enclosing
   * assertion is what names the record this backend actually mints.
   * `gea::host::<Ctor>::create<ErrorRecord>` is a TEMPLATE over the struct
   * (`targets/cpp/runtime/gea_runtime.h`) -- this compiler controls and
   * renders the construction, so it can allocate the asserted shape directly
   * and the extra fields are value-initialized exactly as an omitted property
   * would be. Without it the construction mints one struct and the binding
   * holding it declares another, and no conversion between two unrelated C++
   * structs exists: certified, emitted, and rejected by clang. See
   * `producers/invocations.ts`'s `errorConstructResultOverride`.
   */
  | { readonly kind: 'error-construct-type-assertion' }
  /**
   * `new Map()`/`new Set()`/`new WeakMap()`/`new WeakSet()`: the ambient
   * constructor's own declared signature has nothing to infer K/(V) from --
   * no type arguments, no constructor argument -- so the checker defaults
   * both to `unknown`, and the selected signature's return type is that
   * defaulted, uninformative shape. `collection-bindings.ts`'s whole-program
   * census (`typeArgumentsAt`/`typeArgumentsForOwner`/`typeArgumentsForRead`)
   * answers the SAME question `array-construct-type-annotation` answers for
   * `new Array(n)` one collection family over: what does the program's own
   * later use of this cell actually store. `structural.ts`'s `typeAt` already
   * substitutes that census's answer for this call's own published result
   * (`inferredCollectionTypeArgumentsAt`, `structural-array-element.ts`) --
   * this divergence exists so that substitution does not also have to agree
   * with the SEPARATE, checker-only computation `buildSelectedSignature`
   * derives from the resolved signature object. See
   * `producers/invocations.ts`'s `collectionConstructResultOverride`.
   */
  | { readonly kind: 'collection-construct-type-inference' }
  /**
   * `Object.create(null)`: `lib.es5.d.ts` declares the return type `any`, and
   * the enclosing `as T` assertion or the annotation of the variable/field
   * this call directly initializes is what names the object carrier this
   * backend actually mints. 20.1.2.2's OrdinaryObjectCreate with a null
   * prototype and no own properties is physically an empty
   * `gea::Dictionary<V>` or a value-initialized record struct, and
   * `targets/cpp/host/emit-host-object.ts`'s `createText` -- this compiler's
   * own rendering of the call -- mints exactly that. Without it the call
   * boxes a `DynamicObject` that the annotated store then unboxes into a
   * different C++ payload type, which aborts at runtime rather than failing
   * to compile. See `producers/invocations.ts`'s `objectCreateResultOverride`.
   */
  | { readonly kind: 'object-create-type-annotation' }
  /**
   * `Object.assign(target, source)` returns the target object itself. The
   * ambient generic signature reports `T & U`, which describes the extra
   * properties visible through TypeScript but is not a second allocation and
   * must not become a second physical carrier. The native renderer mutates the
   * target (using its identity-keyed expando table for source keys the target
   * does not declare) and returns that same target handle. See
   * `producers/invocations.ts`'s `objectAssignTargetOverride`.
   */
  | { readonly kind: 'object-assign-target-identity' }
  /**
   * `collection.get( k )` on a `Map`/`WeakMap` that same census bound: the
   * sibling of the construct divergence above, at the OTHER end of the same
   * storage. Fixing the receiver's type does not fix this call, because a
   * prototype call's result comes from the callee's SIGNATURE, which the
   * checker instantiates from the receiver EXPRESSION's type rather than from
   * whatever this compiler selected for it -- so `buildSelectedSignature`
   * derives `any` from the resolved signature while `structural.ts`'s `typeAt`
   * publishes the census's `V | undefined`
   * (`collectionMemberResultTypeAt`, `structural-array-element.ts`). The two
   * are not in conflict; the signature is simply the half the checker could
   * not instantiate. See `producers/invocations.ts`'s
   * `collectionMemberResultOverride`.
   */
  | { readonly kind: 'collection-member-type-inference' }
  /**
   * A call that RETURNS an object bag: three's `WebGLProperties.get`, whose
   * body is `let map = properties.get( object ); if ( map === undefined ) {
   * map = {}; ... } return map`. Nothing in the source states that return
   * type, so `buildSelectedSignature` derives `any` from the resolved
   * signature, while `object-bag-bindings.ts`'s whole-program census bound the
   * 47 members the renderer then reads off it and `structural.ts`'s `typeAt`
   * publishes them (`bagShapeTypeAt` via `callResultShapeAt`).
   *
   * The bag census REFUSES to answer at a call unless a caller takes on this
   * declaration -- see `callResultShapeAt`'s own header for the measurement
   * that made that rule (withheld 8 -> 20 when only one authority moved). See
   * `producers/invocations.ts`'s `bagResultOverride`.
   */
  | { readonly kind: 'bag-return-inference' }
  /**
   * `const K = Symbol.for('k')`: TypeScript's own rule, not this compiler's.
   * `checkCallExpression` replaces a `Symbol()`/`Symbol.for()` call's result
   * with a FRESH `unique symbol` type when the call is the initializer of a
   * `const` declaration or a `readonly static` property, while the selected
   * signature still returns plain `symbol`. Both are the same physical thing
   * -- `representation/derive.ts` maps `unique-symbol` and `symbol` to the one
   * `{ kind: 'symbol' }` carrier -- so nothing downstream has to choose; this
   * arm exists to say the disagreement is the language's, so a disagreement
   * that is NOT can still fail closed.
   */
  | { readonly kind: 'unique-symbol-fresh-type' }
  /**
   * `Array.of.call(Pack, ...)` / `Array.prototype.map.call(arrayLike, fn)`:
   * `Function.prototype.call`/`.apply`'s own ambient signature
   * (`call<T, A extends any[], R>(this: (this: T, ...args: A) => R, thisArg:
   * T, ...args: A): R`) ties its return type to ONE inferred parameter `R`,
   * which loses precision the moment the receiver's own call is itself
   * generic or overloaded (`Array.prototype.map<U>(...): U[]` has its own
   * free `U` nothing in `.call`'s three type parameters resolves through).
   * `normalize/structural-callable.ts`'s `createStructuralCallResultResolver`
   * reads the receiver's OWN authenticated call signature(s) directly instead
   * -- the same "receiver has a call signature" test
   * `flow/callable-reach.ts`'s `unwrapExplicitThisCall` makes of the identical
   * shape -- and `structural.ts`'s `callResultAt` already wires that answer
   * into `context.types.typeAt(node)`, which is what an invocation's
   * published result falls back to. This licenses the resulting disagreement
   * against the checker's own overload-resolved `signature.getReturnType()`;
   * see `producers/invocations.ts`'s `isExplicitThisCallWithAuthenticatedReceiver`.
   */
  | { readonly kind: 'explicit-this-call-return' }
  | { readonly kind: 'none' }

/**
 * Fail closed when the invocation result and the selected return type disagree
 * for a reason the language does not license.
 *
 * A divergence that is real must be declared, not inferred downstream. If this
 * throws, the producer published two answers for one operation.
 */
export const validateInvocationResult = (
  signature: SelectedSignature,
  invocationResult: StructuralTypeId,
  divergence: InvocationResultDivergence
): void => {
  if (divergence.kind !== 'none') return
  if (signature.returnType === invocationResult) return
  throw new Error(
    `invocation result ${invocationResult} disagrees with selected return type ${signature.returnType} ` +
      `for declaration ${signature.declaration} with no declared divergence`
  )
}

/**
 * Instantiated parameter types, or `null` when the checker withheld the mapper.
 *
 * Returning `null` is the fail-closed answer. A caller must handle it by
 * reporting a missing capability, never by reconstructing substitutions.
 */
export const instantiatedParameterTypes = (signature: SelectedSignature): readonly StructuralTypeId[] | null => {
  if (signature.typeArguments.kind === 'inferred') return null
  return signature.parameters.map((parameter) => parameter.type)
}

/**
 * Whether the checker's own `unique symbol` rule is what made this call's
 * result differ from its signature's return type.
 *
 * TypeScript's `checkCallExpression` gives a `Symbol()`/`Symbol.for()` call a
 * FRESH `unique symbol` type when the call initializes a `const` declaration or
 * a `readonly static` property, while the signature it selected still returns
 * plain `symbol`. That is the language's rule, and this reads the checker's own
 * two answers to recognize it -- the flags on the published result and on the
 * selected signature's return type -- rather than re-deriving which callees the
 * rule applies to from a name. A disagreement of any other shape still fails
 * closed in `validateInvocationResult`.
 */
export const isUniqueSymbolFreshType = (checker: ts.TypeChecker, node: ts.Node, signature: ts.Signature | undefined): boolean => {
  if (signature === undefined) return false
  // STATED, not HOLDS: per the doc comment above, this deliberately compares
  // two of the CHECKER's own answers (the published result's flags against
  // the selected signature's return-type flags) to recognize one specific
  // language rule (a fresh `unique symbol` from `Symbol()`/`Symbol.for()`).
  // It is not asking what this node holds as a value -- it is asking whether
  // the checker itself treated this call specially -- so a census substitute
  // would compare the wrong pair of types and could stop recognizing the
  // rule. Left as a direct checker call.
  if ((checker.getTypeAtLocation(node).flags & ts.TypeFlags.UniqueESSymbol) === 0) return false
  return (checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.ESSymbol) !== 0
}
