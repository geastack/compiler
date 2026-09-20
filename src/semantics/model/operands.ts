import type { FunctionId, OperationId, RegionId, ResultRole, SemanticResultId, StructuralTypeId } from '../../identity/ids.js'
import type { ConversionRoleTarget } from './operations.js'

/**
 * Who executes an operation.
 *
 * A function caller and a region caller are different identities. `null` is not
 * a caller: an operation with no owner is a normalization defect, because every
 * expression in a program executes inside some function body, module body,
 * initializer, or static block.
 */
export type SemanticCaller =
  { readonly kind: 'function'; readonly functionId: FunctionId } | { readonly kind: 'region'; readonly regionId: RegionId }

/**
 * Where an operand's value comes from.
 *
 * `result` is the ordinary case: the value another operation published. A
 * `constant` carries its own value. `absent` records an operand position the
 * language defines but this site does not fill -- an omitted array element, a
 * missing `else` -- and is distinct from an operand whose value is `undefined`.
 *
 * `parameter` is the fourth, and it exists because a formal parameter's value
 * is genuinely none of the other three: the caller's frame supplies it, so no
 * operation in this body publishes it (`result` is wrong), and its value is
 * not data known here (`constant` is wrong). Spelling it `absent` would say
 * the position is unfilled, which is how a parameter ends up read from a cell
 * nothing ever wrote.
 *
 * `receiver` is the same fact for `this`. `ResolveThisBinding` reads the
 * running execution context's function environment, which the caller
 * established -- so it is supplied by the frame exactly as a parameter is, and
 * it carries no ordinal because a convention has at most one receiver.
 */
/**
 * Which of the language's literal forms a constant is.
 *
 * The text alone cannot say: the string literal `'undefined'` and the language
 * value `undefined` both spell themselves `undefined`, and `typeof x !==
 * 'undefined'` puts the first one in every program that guards an ambient
 * global. Reading the text and guessing is how the absent value and a five-
 * letter string become the same operand, so the form is carried rather than
 * inferred.
 */
export type ConstantLiteral = 'string' | 'number' | 'bigint' | 'boolean' | 'null' | 'undefined'

export type OperandSource =
  | { readonly kind: 'result'; readonly result: SemanticResultId }
  | { readonly kind: 'constant'; readonly text: string; readonly literal: ConstantLiteral }
  | { readonly kind: 'absent' }
  | { readonly kind: 'parameter'; readonly ordinal: number }
  | { readonly kind: 'receiver' }

/**
 * Whether an operand is executed here.
 *
 * `runtime` operands are evaluated by this operation, in the order they appear.
 * `provenance` operands are already covered by another operand and must not be
 * evaluated twice: a member call's callee is one runtime step, and its receiver
 * is recorded for authority without being re-evaluated.
 * `conditional` operands are evaluated only when the guard result is taken,
 * which is how short-circuiting stays a semantic fact rather than an emitter
 * convention.
 */
export type OperandEvaluation =
  | { readonly kind: 'runtime' }
  | { readonly kind: 'provenance' }
  | { readonly kind: 'conditional'; readonly guard: SemanticResultId; readonly takenWhen: 'truthy' | 'falsy' | 'nullish' | 'present' }

/** One input to an operation, with its shape and its evaluation behavior. */
export interface SemanticOperand {
  /** The role this operand fills in its operation, e.g. `receiver`, `argument`. */
  readonly role: string
  /** Position within a repeated role, so argument order survives normalization. */
  readonly ordinal: number
  readonly source: OperandSource
  readonly type: StructuralTypeId
  readonly evaluation: OperandEvaluation
  /**
   * For a `spread-argument` operand only: the index its range copy starts
   * from, when the positions before it were read explicitly. An open-ended
   * tuple `[A, ...B[]]` spread into `f(a: A, ...rest: B[])` reads `[0]` as
   * its own positional argument and range-copies the tail from 1
   * (`spread-arguments.ts`). Absent means 0, the whole source.
   */
  readonly from?: number
}

/** One result an operation publishes, keyed by the role it fills. */
export interface SemanticResult {
  readonly id: SemanticResultId
  readonly role: ResultRole
  readonly type: StructuralTypeId
}

/**
 * How an operation can complete.
 *
 * Abrupt completion is part of the operation, not an emitter concern. An
 * operation that can throw and one that cannot are different semantics, and a
 * consumer that assumes normal completion must be able to see the difference.
 */
export interface CompletionBehavior {
  readonly canThrow: boolean
  readonly canReturn: boolean
  readonly canBreak: boolean
  readonly canContinue: boolean
  readonly canSuspend: boolean
}

export const normalCompletion: CompletionBehavior = Object.freeze({
  canThrow: false,
  canReturn: false,
  canBreak: false,
  canContinue: false,
  canSuspend: false
})

export const throwingCompletion: CompletionBehavior = Object.freeze({
  canThrow: true,
  canReturn: false,
  canBreak: false,
  canContinue: false,
  canSuspend: false
})

/**
 * Observable effects of an operation.
 *
 * These are semantic facts used to order and join operations, never a licence
 * to skip evaluation. An operation with no recorded effect may still be
 * ordered by an evaluation edge.
 */
export interface EffectBehavior {
  readonly readsMutableState: boolean
  readonly writesMutableState: boolean
  readonly allocates: boolean
  readonly callsUserCode: boolean
}

export const pureEffects: EffectBehavior = Object.freeze({
  readsMutableState: false,
  writesMutableState: false,
  allocates: false,
  callsUserCode: false
})

/** Fields every normalized operation carries regardless of its family. */
export interface SemanticOperationBase {
  readonly id: OperationId
  readonly caller: SemanticCaller
  readonly operands: readonly SemanticOperand[]
  readonly results: readonly SemanticResult[]
  readonly completion: CompletionBehavior
  readonly effects: EffectBehavior
  /** Exact storage targets published by the producer for operand conversion roles it owns. */
  readonly conversionRoles?: readonly ConversionRoleTarget[]
  /**
   * The order this operation's own evaluation occupies within its caller. It
   * orders siblings; it is not a source offset and carries no file position.
   */
  readonly evaluationOrdinal: number
}

/** The operand filling one role, or `undefined` when the site omits it. */
export const operandOf = (operation: SemanticOperationBase, role: string, ordinal = 0): SemanticOperand | undefined =>
  operation.operands.find((operand) => operand.role === role && operand.ordinal === ordinal)

/** The result filling one role, or `undefined` when the operation omits it. */
export const resultOf = (operation: SemanticOperationBase, role: ResultRole): SemanticResult | undefined =>
  operation.results.find((result) => result.role === role)

/** The operands this operation actually evaluates, in evaluation order. */
export const runtimeOperands = (operation: SemanticOperationBase): readonly SemanticOperand[] =>
  operation.operands.filter((operand) => operand.evaluation.kind !== 'provenance')
