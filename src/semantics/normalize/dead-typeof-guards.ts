import ts from 'typescript'
import type { OperationId } from '../../identity/ids.js'
import type { AbsentGlobalCensus } from './absent-globals.js'
import type { IdentityTable } from './identities.js'

/**
 * Provably-dead consequents of a host-absence `typeof` guard.
 *
 * `absent-globals.ts` answers "is this value/type absent" at a POSITION. This
 * answers a different question: is a whole REGION of code unreachable,
 * because the guard that would have to pass for it to run cannot pass on
 * this host. The two are not the same fact and must not share a mechanism --
 * see the doc comment on `isDeadOperation` below for why.
 *
 * Scope, deliberately narrow, matching exactly what a real corpus program
 * does and nothing more:
 *
 *   if ( typeof X !== 'undefined' && x instanceof X ) { ... }
 *
 * Both conjuncts must independently resolve, BY SYMBOL through
 * `AbsentGlobalCensus.typeAt` (never by spelling), to a host-declared-absent
 * ambient value. `X` cannot exist on this host, so `typeof X !== 'undefined'`
 * is provably `false`; `&&` short-circuits; the consequent never executes.
 * That is a proof from the host's own statement, not an inference this
 * compiler drew -- the one warrant this rule is allowed to rest on. Either
 * conjunct may be individually wrapped in its own `( ... )` (three.js's
 * `Source.js`) -- `unwrapParens` strips that before the shape checks, since
 * it is a syntactic artifact of how the source was written, not a different
 * logical shape. Only the `!==` polarity is handled. The `else`/`else if`
 * chain is never touched: it
 * is the code that actually runs on this host. A `typeof` guard that is not
 * this exact `&&`-of-two-conjuncts shape -- nested inside a longer `&&`/`||`
 * chain, written as a ternary, or checked with `===` and an early return --
 * is out of scope and left alone rather than guessed at.
 */
export interface DeadTypeofGuardCensus {
  /**
   * Whether an operation's own source position falls inside a proven-dead
   * guard consequent.
   *
   * Keyed on the OPERATION's identity, not on any operand's structural type.
   * That is the fix for the defect the prior (reverted) rule had: a
   * structural `never` is a single, shape-only fact that TypeScript's own
   * (sometimes unsound) inference produces just as often as a host-absence
   * proof does, and once interned every occurrence collapses to the SAME
   * structural type id -- there is no way to tell, from a `StructuralTypeId`
   * alone, which `never` a given position's is. Reachability, by contrast,
   * is a property of WHERE in the source an operation sits, which this
   * census proves directly from the guard's own AST shape and the host's own
   * absence statement, never from what type anything infers to.
   */
  readonly isDeadOperation: (id: OperationId) => boolean
  /** How many qualifying guards were found, for measurement. */
  readonly guardCount: number
}

export const emptyDeadTypeofGuardCensus: DeadTypeofGuardCensus = {
  isDeadOperation: () => false,
  guardCount: 0
}

/** Whether `expr` is the string literal `'undefined'`. */
const isUndefinedStringLiteral = (expr: ts.Expression): boolean => ts.isStringLiteralLike(expr) && expr.text === 'undefined'

/**
 * Strips a wrapping `( ... )`, repeatedly.
 *
 * `( typeof HTMLVideoElement !== 'undefined' ) && ( data instanceof
 * HTMLVideoElement )` (three.js's `Source.js`) is the identical `&&`-of-two-
 * conjuncts shape this module matches, with each conjunct individually
 * parenthesized -- a purely syntactic wrapper TypeScript's parser leaves in
 * the tree as a `ParenthesizedExpression` node around an otherwise identical
 * `BinaryExpression`. Unwrapping it before the shape checks below admits no
 * new logical shape -- the `&&`, the `typeof`, the `instanceof`, and the
 * symbol-resolved host-absence proof are all still required exactly as
 * before -- it only stops a wrapper the parser inserts from hiding a shape
 * this module already handles.
 */
const unwrapParens = (expr: ts.Expression): ts.Expression => {
  let current = expr
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

/**
 * `typeof <operand> !== 'undefined'`, where `<operand>` resolves BY SYMBOL
 * (through `absent.typeAt`, the same resolution `absent-globals.ts` already
 * uses everywhere else) to a host-declared-absent ambient value -- or `null`
 * when `expr` is not that shape, or resolves to nothing this host denied.
 *
 * A program's own same-named local is untouched: `typeAt` only answers for a
 * reference whose SYMBOL is the standard library's ambient declaration a host
 * listed, exactly as every other consumer of `AbsentGlobalCensus` requires.
 */
const absentTypeofOperand = (expr: ts.Expression, absent: AbsentGlobalCensus): ts.Expression | null => {
  if (!ts.isBinaryExpression(expr)) return null
  if (expr.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return null
  const left = expr.left
  const right = expr.right
  const [typeofExpr, literal] = ts.isTypeOfExpression(left) ? [left, right] : ts.isTypeOfExpression(right) ? [right, left] : [null, null]
  if (!typeofExpr || !literal) return null
  if (!isUndefinedStringLiteral(literal)) return null
  return absent.typeAt(typeofExpr.expression) !== null ? typeofExpr.expression : null
}

/**
 * `<expr> instanceof <name>`, where `<name>` ALSO resolves by symbol to a
 * host-declared-absent value -- checked independently of, not merely
 * spelling-matched against, the `typeof` guard's own operand. Two conjuncts
 * that each independently name an absent global is at least as strong a
 * proof as one that textually repeats a name, and it costs nothing extra:
 * `absent.typeAt` is already the one authority for "is this reference
 * absent," so asking it twice is asking the same question at two positions,
 * never a second question.
 */
const isInstanceofAbsentName = (expr: ts.Expression, absent: AbsentGlobalCensus): boolean =>
  ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && absent.typeAt(expr.right) !== null

/**
 * Whether this condition is PROVABLY FALSE from the host's own absence
 * statement -- one `typeof X !== 'undefined' && v instanceof X` conjunction,
 * or a `||` chain of them where EVERY disjunct is one.
 *
 * three's `resizeImage` (`WebGLTextures.js`) is the disjunctive form, and it
 * is the shape that matters: four clauses, one each for `HTMLImageElement`,
 * `HTMLCanvasElement`, `ImageBitmap` and `VideoFrame`, all four host-absent.
 * A disjunction is false exactly when every disjunct is false, so the warrant
 * is unchanged and the consequent is as dead as a single conjunction's -- the
 * shape was simply not matched. Its `return canvas` then stops counting as
 * evidence about what the function returns, and the remaining returns can
 * agree.
 *
 * Requiring EVERY disjunct is what keeps this sound: one live clause makes the
 * whole condition possibly true, and there is no partial credit to take.
 *
 * WHAT IT IS WORTH, MEASURED: 12 fewer obligations on the three.js app and nothing else.
 * missingRows is unchanged (408), so none of the twelve were mandatory, and the
 * boxed count does not move.
 *
 * ⛔ The obvious next step does NOT pay, and this is the place to say so. It
 * looks as though `return-bindings.ts` should consult reachability -- a `return`
 * inside a proven-dead branch is not evidence about what a function returns, and
 * `resizeImage` (`WebGLTextures.js`) is exactly that shape: `return canvas`
 * inside this guard, refusing the census against the other returns. It gains
 * nothing. `resizeImage`'s other two returns are both `return image`, and
 * `image` is its own unannotated parameter, so the census refuses on `any` with
 * or without the dead arm excluded. The dead arm was never the binding
 * constraint. Threading a node-level reachability predicate into the return
 * census (which would also mean building `absent` before the census chain) buys
 * nothing until the parameter underneath it is typed.
 *
 * ⛔ Read `dead-typeof-guards`'s own header before widening this further. The
 * warrant is the HOST'S STATEMENT about a global it declares absent -- never a
 * type. A previous rule keyed on a `never` operand marked LIVE code satisfied,
 * because TypeScript produces `never` from its own unsound inferences (an
 * empty array literal, most memorably) just as readily as an absence proof
 * does, and once interned the two are the same structural id. Reachability is
 * a property of WHERE an operation sits, proven here from the guard's AST
 * shape and the host's own list.
 */
const isProvablyFalseGuard = (expr: ts.Expression, absent: AbsentGlobalCensus): boolean => {
  const condition = unwrapParens(expr)
  if (!ts.isBinaryExpression(condition)) return false
  if (condition.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return isProvablyFalseGuard(condition.left, absent) && isProvablyFalseGuard(condition.right, absent)
  }
  if (condition.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) return false
  return absentTypeofOperand(unwrapParens(condition.left), absent) !== null && isInstanceofAbsentName(unwrapParens(condition.right), absent)
}

/**
 * The census for one program.
 *
 * `emptyDeadTypeofGuardCensus` is returned unchanged when the host census
 * itself is empty (`absent.absentCount === 0`): nothing is absent, so no
 * `typeof` guard on this program can ever be proven dead by this rule, and
 * walking every file to confirm that would be pure cost.
 */
export const censusDeadTypeofGuards = (
  files: readonly ts.SourceFile[],
  absent: AbsentGlobalCensus,
  identities: IdentityTable
): DeadTypeofGuardCensus => {
  if (absent.absentCount === 0) return emptyDeadTypeofGuardCensus

  const deadSitePrefixes: string[] = []
  let guardCount = 0

  const markDead = (node: ts.Node): void => {
    deadSitePrefixes.push(`op|${identities.nodeIdOf(node)}|`)
    ts.forEachChild(node, markDead)
  }

  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isIfStatement(node) && isProvablyFalseGuard(node.expression, absent)) {
        markDead(node.thenStatement)
        guardCount += 1
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }

  // `OperationId` is `op|<NodeId>|<family>|<ordinal>`, and a `NodeId` embeds
  // its own unescaped `|`s (`identity/ids.ts`'s `operationId`/`nodeId`), so
  // the operation id cannot be split apart and reassembled -- exactly the
  // hazard `identity/ids.ts`'s own `operationOfResult` comment names. A
  // prefix test sidesteps it entirely: `deadSitePrefixes` holds full,
  // independently-computed `op|<deadNodeId>|` strings, and `startsWith`
  // matches an operation to one of them without parsing anything.
  const isDeadOperation = (id: OperationId): boolean => deadSitePrefixes.some((prefix) => (id as string).startsWith(prefix))

  return { isDeadOperation, guardCount }
}
