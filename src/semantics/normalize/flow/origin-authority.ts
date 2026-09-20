import ts from 'typescript'
import type { NativeCollectionProtocolPlan } from './native-collection-protocol.js'
import type { ClosedCallableAuthority } from './callable-array-origins.js'
import type { SourceInvocationFact } from './invocation-facts.js'
import type { IntrinsicProtocolRequirement } from '../deferred-intrinsic-protocols.js'

/** A provenance answer computed under the deferred-protocol ledger's capture. */
export interface SharedProvenanceAnswer<T> {
  readonly value: T | null
  readonly requirements: readonly IntrinsicProtocolRequirement[]
}

// Shared provenance authorities for record, array, and callable walks.
/** @semanticCategory generic-primitive */
export interface SourceRecordOriginAuthority {
  /** Complete inbound frame, including defaults and writes; partial callers are not evidence. */
  readonly parameterValuesOf: (parameter: ts.ParameterDeclaration) => readonly ts.Expression[] | null
  readonly checker: ts.TypeChecker
  readonly protocolClosed: (plan: NativeCollectionProtocolPlan) => boolean
  /** Index keys the checker cannot type as numbers; see `arrayStoredValuesOf`. */
  readonly numericKey: (key: ts.Expression) => boolean
  /** Whole-program proof for record slots the local alias walk cannot follow. */
  readonly recordSlotClosed: (receiver: ts.Expression, key: string, roots: readonly ts.ObjectLiteralExpression[]) => boolean
  /** The complete values a slot read yields, from the joint value graph, or
   * null where it refuses: `renderer.state` filled by `_this.state = state`
   * in a constructor, which no record-literal plan can see through. */
  readonly slotValuesOf?: (access: ts.PropertyAccessExpression | ts.ElementAccessExpression) => readonly ts.Expression[] | null
  /** The complete values any expression holds, from the joint value graph, or null where it refuses. */
  readonly graphValuesOf?: (expression: ts.Expression) => readonly ts.Expression[] | null
}

// One caller frame shared by every traversal that can continue a value.
/** @semanticCategory generic-primitive */
export interface OriginAuthority extends SourceRecordOriginAuthority, ClosedCallableAuthority {
  readonly receiverValuesOf: NonNullable<ClosedCallableAuthority['receiverValuesOf']>
  readonly closedCallerSitesOf: NonNullable<ClosedCallableAuthority['closedCallerSitesOf']>
  readonly arrayElementTargetsOf: NonNullable<ClosedCallableAuthority['arrayElementTargetsOf']>
  readonly explicitInvocationIsIntact: NonNullable<ClosedCallableAuthority['explicitInvocationIsIntact']>
  readonly invocationFactOf: (call: ts.CallExpression) => SourceInvocationFact | null
  readonly bindingValuesOf: (declaration: ts.VariableDeclaration) => readonly ts.Expression[] | null
  /** Direct integrity check when available; otherwise obligations enter the deferred ledger. */
  readonly intrinsicIntact?: (intrinsic: 'Object' | 'Array', member: string | undefined, location: ts.Node) => boolean
  /** Publish a positive memo only after its enclosing coinductive proof settles. */
  readonly whenSettled: (publish: () => void) => void
  /**
   * Compute a provenance answer once for every proof that holds the same
   * coinductive parks. A record plan or an array inventory depends on the
   * authority only through its parks (the members, families, record and
   * value proofs assumed open up the stack) and its two key functions, not on
   * which proof happened to ask -- yet the caller-identity caches above are
   * keyed on the authority OBJECT, which every proof mints afresh, so the three.js app
   * rebuilt the same origin solvers 115 million times. The authority records
   * which parks the computation leaned on and replays the answer wherever
   * those same parks are in force; `shareable` withholds an answer -- refusal
   * or not -- that the caller knows was computed from an incomplete view (a
   * re-entered inventory), which is the one thing the trail cannot see.
   */
  readonly sharedAnswerOf?: <T>(
    identity: string,
    compute: () => T | null,
    shareable?: (value: T | null) => boolean
  ) => SharedProvenanceAnswer<T>
}

/** Structural cache identity is the complete caller authority object itself. */
export const originAuthorityIdentity = (authority: OriginAuthority): object => authority
