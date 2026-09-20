import ts from 'typescript'
import { unwrapErasedExpression } from '../producers/erasure.js'

const TEXT_SINK_MEMBERS: ReadonlySet<string> = new Set(['log', 'error'])

/** The three hooks a ToString/ToPrimitive conversion can reach. */
const coercionHook = (name: string): boolean => name === 'toString' || name === 'valueOf' || name.startsWith('__@toPrimitive')

const declaredByHost = (symbol: ts.Symbol): boolean =>
  (symbol.declarations?.length ?? 0) > 0 && symbol.declarations!.every((declaration) => declaration.getSourceFile().hasNoDefaultLib)

/**
 * Whether stringifying a value of this type can execute code this program
 * wrote. Only the intrinsic hooks matter: a data member is read by the
 * emitter's own rendering, never by a source body.
 */
/** Whether every coercion hook this type answers is the host's own. */
export const coercionHooksAreHost = (checker: ts.TypeChecker, type: ts.Type): boolean =>
  checker
    .getPropertiesOfType(checker.getApparentType(type))
    .every((property) => !coercionHook(property.escapedName as string) || declaredByHost(property))

export const coercesWithoutSourceCode = (checker: ts.TypeChecker, type: ts.Type): boolean => {
  if (type.isUnion() || type.isIntersection()) return type.types.every((arm) => coercesWithoutSourceCode(checker, arm))
  if ((type.flags & ts.TypeFlags.Any) !== 0 || (type.flags & ts.TypeFlags.Unknown) !== 0) return false
  if ((type.flags & ts.TypeFlags.Object) === 0) return true
  // An array is rendered by joining its elements, which reaches each element's
  // own hooks. Following that is the element proof's job, not this one's.
  if (checker.isArrayLikeType(type)) return false
  return coercionHooksAreHost(checker, type)
}

/**
 * Whether `reference` is an argument of a `console.log`/`console.error` call on
 * the host's own `console`, and is therefore CONSUMED AS TEXT rather than
 * published.
 *
 * `host-members.ts` claims exactly these two members and lowers them to
 * `gea::host::console::log/error(<text>)`, with `emit-tostring.ts`'s
 * `consoleArgumentsText` rendering every operand at the call site. The host
 * never receives the object, only characters -- so an argument is not a
 * publication of the value, provided the rendering itself runs no source code.
 * Three's `Object3D.add` reports `object` to the console on its
 * added-to-itself guard, and that one argument was the terminal of 35 escapes.
 *
 * `null` means the site is not a text sink and the caller's other rules apply.
 */
export const hostTextSinkArgumentOf = (checker: ts.TypeChecker, reference: ts.Expression): boolean | null => {
  // A spread argument is not one value the sink might keep: it is however many
  // the array holds, each rendered on its own. `console.error( message,
  // ...params )` is the shape three's logging shim ends in.
  const spread = ts.isSpreadElement(reference.parent) && reference.parent.expression === reference ? reference.parent : null
  const call = spread?.parent ?? reference.parent
  if (!ts.isCallExpression(call) || !call.arguments.includes(spread ?? reference)) return null
  if (spread === null && call.arguments.some(ts.isSpreadElement)) return null
  const callee = unwrapErasedExpression(call.expression)
  // `String(value)` is ToString spelled as a call. It is the same consumption:
  // characters come out, the value stays where it was. Source transforms emit
  // it wherever a concatenation's operand has to be converted explicitly.
  if (spread === null && ts.isIdentifier(callee) && callee.text === 'String' && call.arguments.length === 1) {
    const intrinsic = checker.getSymbolAtLocation(callee)
    if (!intrinsic || intrinsic.name !== 'String' || !declaredByHost(intrinsic)) return null
    return coercesWithoutSourceCode(checker, checker.getTypeAtLocation(reference))
  }
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return null
  const member = ts.isPropertyAccessExpression(callee)
    ? callee.name.text
    : ts.isStringLiteralLike(callee.argumentExpression)
      ? callee.argumentExpression.text
      : null
  if (member === null || !TEXT_SINK_MEMBERS.has(member)) return null
  const receiver = unwrapErasedExpression(callee.expression)
  if (!ts.isIdentifier(receiver) || receiver.text !== 'console') return null
  const console = checker.getSymbolAtLocation(receiver)
  if (!console || console.name !== 'console' || !declaredByHost(console)) return null
  const method = checker.getPropertyOfType(checker.getTypeAtLocation(receiver), member)
  if (!method || !declaredByHost(method)) return null
  const rendered = checker.getTypeAtLocation(reference)
  if (spread === null) return coercesWithoutSourceCode(checker, rendered)
  const element = checker.getIndexTypeOfType(rendered, ts.IndexKind.Number)
  return element !== undefined && coercesWithoutSourceCode(checker, element)
}
