import ts from 'typescript'
import { unwrapErasedExpression } from '../producers/erasure.js'

export interface IntrinsicDataDefinitionPlan {
  readonly owner: 'Object' | 'Reflect'
  readonly member: 'defineProperty' | 'defineProperties'
  readonly keys: readonly string[]
  /** Every descriptor's `value` initializer, in definition order: what the definitions store on the target. */
  readonly values: readonly ts.Expression[]
  readonly returnsTarget: boolean
  /**
   * The descriptor fields no descriptor literal spells, which
   * ToPropertyDescriptor reads through `Object.prototype`: a `{ value }`
   * descriptor turns into an accessor the moment someone defines
   * `Object.prototype.get`. Empty exactly when every descriptor carries
   * `__proto__: null`. Asked per key, not as the whole prototype: the three.js app's
   * final census records single keys written through receivers it cannot
   * attribute, which fails the whole-object question for every `Object
   * .defineProperty( this, 'id', { value } )` in three while leaving
   * `writable`, `enumerable`, `configurable`, `get` and `set` untouched.
   */
  readonly descriptorPrototypeKeys: readonly string[]
  readonly call: ts.CallExpression
}

const DESCRIPTOR_FIELDS = ['value', 'writable', 'get', 'set', 'enumerable', 'configurable'] as const

const literalKey = (expression: ts.Node): string | null =>
  ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression) ? expression.text : null

const propertyKey = (name: ts.PropertyName): string | null =>
  ts.isComputedPropertyName(name)
    ? literalKey(unwrapErasedExpression(name.expression))
    : ts.isIdentifier(name)
      ? name.text
      : literalKey(name)

/**
 * Whether every mention of a binding is one this proof already accounts for --
 * its own declaration name, or the argument being inspected.
 */
export type SoleUseOfBinding = (declaration: ts.VariableDeclaration, argument: ts.Expression) => boolean

/** The target argument of a data-only intrinsic definition is not published
 * to user code by that operation. This plan still requires authenticated final
 * static-member identity and, for ordinary descriptor literals, an intact
 * Object prototype: ToPropertyDescriptor reads inherited get/set and flags.
 * Callers must follow Object's returned target, and cannot ignore replacement
 * of the member whose callable or containing-field identity they are proving.
 */
export const intrinsicDataDefinitionTargetOf = (
  checker: ts.TypeChecker,
  reference: ts.Expression,
  soleUseOfBinding?: SoleUseOfBinding
): IntrinsicDataDefinitionPlan | null => {
  const call = reference.parent
  if (!ts.isCallExpression(call) || call.arguments[0] !== reference || call.arguments.some(ts.isSpreadElement)) return null
  const callee = unwrapErasedExpression(call.expression)
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return null
  const member = ts.isPropertyAccessExpression(callee) ? callee.name.text : literalKey(callee.argumentExpression)
  if (member !== 'defineProperty' && member !== 'defineProperties') return null
  const receiver = unwrapErasedExpression(callee.expression)
  if (!ts.isIdentifier(receiver)) return null
  const symbol = checker.getSymbolAtLocation(receiver)
  if (
    !symbol ||
    (symbol.name !== 'Object' && symbol.name !== 'Reflect') ||
    !symbol.declarations?.length ||
    !symbol.declarations.every((declaration) => declaration.getSourceFile().hasNoDefaultLib)
  )
    return null
  const owner = symbol.name
  if (owner === 'Reflect' && member === 'defineProperties') return null
  const method = checker.getPropertyOfType(checker.getTypeAtLocation(receiver), member)
  if (!method?.declarations?.length || !method.declarations.every((declaration) => declaration.getSourceFile().hasNoDefaultLib)) return null
  const keys = new Set<string>()
  const values: ts.Expression[] = []
  const descriptorPrototypeKeys = new Set<string>()
  /**
   * The descriptor literal an argument names.
   *
   * `define-property-source-transform.ts` lowers `Object.defineProperties( o,
   * { ... } )` into one `Object.defineProperty` per key, hoisting each
   * descriptor into its own `const` first so that `defineProperties`' two
   * phases -- evaluate every descriptor, THEN define -- are preserved. That
   * hoist hands this proof an IDENTIFIER where the pre-transform call handed
   * it a literal, and the plan was refused for it: three's `Object3D`
   * constructor defines `position`, `rotation`, `quaternion`, `scale`,
   * `modelViewMatrix` and `normalMatrix` that way, and the receiver `this`
   * was reported escaping through its own lowering.
   *
   * Followed only to a `const` whose single declaration initializes it
   * directly with the literal, and only when nothing else mentions the
   * binding: an alias could otherwise write `d.get = fn` between the `const`
   * and the call, which would turn a data definition into an accessor
   * invocation ON the target and void the premise that the target is not
   * published. Those are exactly the conditions the transform's own output
   * satisfies by construction.
   */
  const descriptorLiteralOf = (expression: ts.Expression): ts.ObjectLiteralExpression | null => {
    const value = unwrapErasedExpression(expression)
    if (ts.isObjectLiteralExpression(value)) return value
    if (!ts.isIdentifier(value) || soleUseOfBinding === undefined) return null
    const declarations = checker.getSymbolAtLocation(value)?.declarations ?? []
    const declaration = declarations.length === 1 ? declarations[0] : undefined
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return null
    if ((ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0) return null
    if (!soleUseOfBinding(declaration, value)) return null
    const initializer = unwrapErasedExpression(declaration.initializer)
    return ts.isObjectLiteralExpression(initializer) ? initializer : null
  }
  const descriptor = (expression: ts.Expression): boolean => {
    const value = descriptorLiteralOf(expression)
    if (value === null) return false
    let nullPrototype = false
    const spelled = new Set<string>()
    for (const property of value.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false
      const key = propertyKey(property.name)
      if (key !== null) spelled.add(key)
      if (
        key === '__proto__' &&
        ts.isPropertyAssignment(property) &&
        !ts.isComputedPropertyName(property.name) &&
        unwrapErasedExpression(property.initializer).kind === ts.SyntaxKind.NullKeyword
      ) {
        nullPrototype = true
        continue
      }
      if (key !== 'value' && key !== 'writable' && key !== 'enumerable' && key !== 'configurable') return false
      if (key === 'value') values.push(ts.isPropertyAssignment(property) ? property.initializer : property.name)
    }
    if (!nullPrototype) for (const field of DESCRIPTOR_FIELDS) if (!spelled.has(field)) descriptorPrototypeKeys.add(field)
    return true
  }
  const entry = (key: string | null, value: ts.Expression): boolean => {
    if (key === null || key === '__proto__' || key === 'constructor' || !descriptor(value)) return false
    keys.add(key)
    return true
  }
  if (member === 'defineProperty') {
    if (call.arguments.length !== 3 || !entry(literalKey(unwrapErasedExpression(call.arguments[1]!)), call.arguments[2]!)) return null
  } else {
    if (call.arguments.length !== 2) return null
    const definitions = unwrapErasedExpression(call.arguments[1]!)
    if (
      !ts.isObjectLiteralExpression(definitions) ||
      !definitions.properties.every(
        (property) => ts.isPropertyAssignment(property) && entry(propertyKey(property.name), property.initializer)
      )
    )
      return null
  }
  return {
    owner,
    member,
    keys: [...keys],
    values,
    returnsTarget: owner === 'Object',
    descriptorPrototypeKeys: [...descriptorPrototypeKeys],
    call
  }
}
