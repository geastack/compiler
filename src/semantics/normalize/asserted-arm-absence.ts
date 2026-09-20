import ts from 'typescript'
import { enclosingCallIfCallee } from './producers/erasure.js'

/**
 * Whether a named read through a type assertion may land on a union arm that
 * has no such member at all.
 *
 * `typeof (options?.body as ReadableStream)?.getReader` in `@hono/node-server`
 * reads off a `string | Buffer | ReadableStream | ...` value. The assertion
 * changes the checker's type and never the value, and the property producer
 * already dispatches the read on the value's real arms; on the string arm
 * 6.2.5.5 GetV answers `undefined`. The checker's type for the read is the
 * asserted arm's bare method, which cannot hold that `undefined`, so the arm
 * had nowhere to put it and rendered a TypeError -- for a program that only
 * asked whether the member was there.
 *
 * One predicate for the two places that publish the read's type: the property
 * producer (the `[[Get]]` itself) and the local-binding census (a `const`
 * initialized by the read, whose checker type is the same bare method).
 *
 * A callee is excluded: calling the `undefined` does throw, and the callee's
 * type is the resolved signature. So are an assertion to `any`/`unknown`, a
 * receiver that is not a union (a genuinely unknown value keeps the
 * assertion's checked unbox), and an arm with a string index signature, which
 * answers its element type.
 *
 * `receiverTypeOf` is the caller's own reading of the asserted operand, so
 * each caller keeps the receiver authority it already uses.
 */
export const assertedReceiverArmMayLackMember = (
  checker: ts.TypeChecker,
  node: ts.Expression,
  receiverTypeOf: (receiver: ts.Expression) => ts.Type
): boolean => {
  if (!ts.isPropertyAccessExpression(node) || enclosingCallIfCallee(node) !== null) return false
  let receiver: ts.Expression = node.expression
  let asserted = false
  while (
    ts.isNonNullExpression(receiver) ||
    ts.isParenthesizedExpression(receiver) ||
    ts.isAsExpression(receiver) ||
    ts.isTypeAssertionExpression(receiver)
  ) {
    asserted ||= ts.isAsExpression(receiver) || ts.isTypeAssertionExpression(receiver)
    receiver = receiver.expression
  }
  if (!asserted) return false
  // An `as any` claims no member, so it has no asserted arm to be wrong about.
  if ((checker.getTypeAtLocation(node.expression).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return false
  const physical = receiverTypeOf(receiver)
  if (!physical.isUnion()) return false
  const name = node.name.text
  const absentFlags = ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.Never
  return physical.types.some((arm) => {
    if ((arm.flags & absentFlags) !== 0) return false
    const apparent = checker.getApparentType(arm)
    // Only a STRING index signature answers a dotted name: `String`'s own
    // numeric one never matches an identifier.
    if (checker.getIndexInfoOfType(apparent, ts.IndexKind.String) !== undefined) return false
    return checker.getPropertyOfType(apparent, name) === undefined
  })
}
