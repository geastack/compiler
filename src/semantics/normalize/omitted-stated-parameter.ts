import ts from 'typescript'
import {
  isForeignClassInstance,
  annotationStatesNothing,
  containsUnstatedPosition,
  isUnusableEvidence,
  jsDocTypeStatesNothing
} from './derived-expression-type.js'
import { unionTypeOf } from './parameter-slot.js'

/**
 * A JavaScript parameter whose JSDoc states its type, but which some caller
 * leaves out.
 *
 * The declaration overlay now carries `@types/three`'s parameter types into
 * three's own sources, and `.d.ts` files state what a well-typed caller
 * passes -- not what three itself passes. `WebGLState`'s `ColorBuffer`:
 *
 *     // @param {boolean} premultipliedAlpha      (required in the .d.ts)
 *     setClear: function ( r, g, b, a, premultipliedAlpha ) {
 *       if ( premultipliedAlpha === true ) { ... }
 *     }
 *
 *     colorBuffer.setClear( 0, 0, 0, 1 );                // WebGLState
 *     _state.buffers.color.setClear( 0, 0, 0, 0 );       // WebGLShadowMap
 *
 * A readable JSDoc type keeps a parameter out of the census's inference
 * (`isUnannotated`), and the tag is no optionality mark, so the parameter
 * kept its bare statement: a `scalar(boolean)` slot, which the emitter then
 * correctly refused to call with the `undefined` ECMAScript binds for an
 * argument the call does not pass.
 *
 * The parameter's real value set is the statement's values plus that
 * `undefined` when at least one caller omits the argument, plus the type of
 * every argument a caller passes that the statement does not admit. No
 * checker verifies a JavaScript file's tag against its callers, so a caller
 * passing something else disproves it for that caller exactly as an omission
 * does: pino's `@param {string} destination` on `normalizeDestFileDescriptor`,
 * called with the Number `process.stdout.fd`. An argument a spread may or may
 * not supply, or one no census can type, is unknown, and refuses -- except
 * that an untyped argument beside a disproving one leaves the cell `any`,
 * since nothing states it any more. A caller
 * set the census cannot close does NOT: a caller it cannot see is held to the
 * statement exactly as it is when this rule is silent, so it adds nothing the
 * widened type lacks, and cannot remove what a visible caller passes.
 * An OPTIONAL parameter is this case too: `withDeclaredAbsence` joins its
 * omission, but not an argument outside the statement -- fastify's
 * `reqIdGenFactory`, `@param {string} [requestIdHeader]`, is handed `false`
 * when no header is configured. A DEFAULTED parameter is not (the default
 * answers the omission), nor a rest or destructured one.
 */

/**
 * The expressions whose values an argument evaluates to: the branches of a
 * conditional, through parentheses and a `const` the argument names (one hop,
 * its initializer), each of which the argument's value comes from.
 */
const valueBranchesOf = (checker: ts.TypeChecker, expression: ts.Expression, followed = false): readonly ts.Expression[] => {
  if (ts.isParenthesizedExpression(expression)) return valueBranchesOf(checker, expression.expression, followed)
  if (ts.isConditionalExpression(expression))
    return [...valueBranchesOf(checker, expression.whenTrue, true), ...valueBranchesOf(checker, expression.whenFalse, true)]
  if (!followed && ts.isIdentifier(expression)) {
    const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration
    const list = declaration?.parent
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      list &&
      ts.isVariableDeclarationList(list) &&
      (list.flags & ts.NodeFlags.Const) !== 0
    )
      return valueBranchesOf(checker, declaration.initializer, true)
  }
  return followed ? [expression] : []
}

/**
 * Whether a statement names plain object data -- no primitive, callable,
 * array, class instance or library type among its members. A dynamic object
 * can be held to such a statement only by rebuilding it field by field, which
 * drops its identity and every member the statement does not declare.
 */
export const statesPlainObject = (checker: ts.TypeChecker, stated: ts.Type): boolean => {
  const type = checker.getNonNullableType(stated)
  const parts = type.isUnion() || type.isIntersection() ? type.types : [type]
  return parts.every(
    (part) =>
      (part.flags & ts.TypeFlags.Object) !== 0 &&
      part.getCallSignatures().length === 0 &&
      part.getConstructSignatures().length === 0 &&
      !checker.isArrayType(part) &&
      !checker.isTupleType(part) &&
      ((part.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class) === 0 &&
      !(part.getSymbol()?.declarations ?? []).some((declaration) => declaration.getSourceFile().hasNoDefaultLib)
  )
}

/**
 * Whether an argument type leaves a plain object member of the statement
 * untyped: fastify's `route.call(this, { options, isFastify })` hands
 * `{ options: RouteOptions, isFastify: boolean }` a literal whose `options` is
 * the `any` copy `prepareRoute` built with `Object.assign`.
 */
const leavesStatedObjectMemberUntyped = (checker: ts.TypeChecker, argument: ts.Type, stated: ts.Type): boolean => {
  const statement = checker.getNonNullableType(stated)
  if (statement.isUnion()) return false
  return statement.getProperties().some((member) => {
    const declared = checker.getTypeOfSymbol(member)
    if (!statesPlainObject(checker, declared)) return false
    const passed = checker.getPropertyOfType(argument, member.getName())
    return passed !== undefined && (checker.getTypeOfSymbol(passed).flags & ts.TypeFlags.Any) !== 0
  })
}

/**
 * The JSDoc statement of a destructured JavaScript parameter, when it names
 * plain object data. Such a parameter takes part in the untyped-argument rule
 * only (`holdsUntypedArguments`): its statement is not joined with an
 * omission, since destructuring an omitted argument throws.
 */
export const destructuredPlainObjectStatementOf = (checker: ts.TypeChecker, parameter: ts.ParameterDeclaration): ts.Type | null => {
  if ((parameter.flags & ts.NodeFlags.JavaScriptFile) === 0) return null
  if (parameter.dotDotDotToken || parameter.initializer || !ts.isObjectBindingPattern(parameter.name)) return null
  const tag = ts.getJSDocType(parameter)
  if (!tag || jsDocTypeStatesNothing(checker, tag)) return null
  const stated = checker.getTypeFromTypeNode(tag)
  if (isUnusableEvidence(stated) || annotationStatesNothing(checker, tag, stated) || containsUnstatedPosition(checker, tag, stated))
    return null
  return statesPlainObject(checker, stated) ? stated : null
}

export type OmittedStatedParameterAnswer = { readonly type: ts.Type } | { readonly refused: string }

/** The JSDoc statement of a JavaScript parameter this rule may widen, or `null`. */
export const omissionStatedTypeOf = (checker: ts.TypeChecker, parameter: ts.ParameterDeclaration): ts.Type | null => {
  if ((parameter.flags & ts.NodeFlags.JavaScriptFile) === 0) return null
  if (parameter.dotDotDotToken || parameter.initializer || !ts.isIdentifier(parameter.name)) return null
  const tag = ts.getJSDocType(parameter)
  if (!tag || jsDocTypeStatesNothing(checker, tag)) return null
  const stated = checker.getTypeFromTypeNode(tag)
  if (isUnusableEvidence(stated) || (stated.flags & ts.TypeFlags.Unknown) !== 0) return null
  if (annotationStatesNothing(checker, tag, stated)) return null
  // A statement with a hole in it is not this rule's to publish. The overlay
  // spells `@param {Array<Light>}` in files that never import `Light`, which
  // the checker reads as `any[]`; `jsdoc-type-names.ts` resolves such names
  // one census further out. A binding published here would outrank it with
  // the `any` element, and every typed array a caller passes would then need
  // a conversion into a dynamic-element array, which no runtime installs.
  if (containsUnstatedPosition(checker, tag, stated)) return null
  // An optional parameter's statement includes the absence it declares.
  return checker.isOptionalParameter(parameter) ? checker.getTypeAtLocation(parameter.name) : stated
}

/**
 * The statement joined with what the (already closed) caller set passes
 * outside it: `undefined` where a caller omits the argument at `index`, and
 * the widened type of each argument the statement does not admit.
 *
 * `null` when every caller passes a value the statement admits -- or there is
 * no attributed caller at all -- so the statement stands as written and this
 * rule has nothing to say (and nothing to refuse).
 */
export const widenedStatedParameter = (
  checker: ts.TypeChecker,
  stated: ts.Type,
  index: number,
  calls: readonly (ts.CallExpression | ts.NewExpression)[],
  argumentsOf: (call: ts.CallExpression | ts.NewExpression) => readonly ts.Expression[] | undefined,
  argumentType: (argument: ts.Expression) => ts.Type | null,
  holdsUntypedArguments = false,
  untypedArgumentsOnly = false
): OmittedStatedParameterAnswer | null => {
  // `new F` with no argument list passes nothing at all.
  const argumentLists = calls.map((call) => argumentsOf(call) ?? [])
  // A spread at or before the position may or may not reach it.
  const reachedBySpread = (args: readonly ts.Expression[]): boolean => args.slice(0, index + 1).some(ts.isSpreadElement)
  const omitted = argumentLists.some((args) => args[index] === undefined && !reachedBySpread(args))
  const outside: ts.Type[] = []
  let unknown: string | null = null
  let typed = 0
  let untyped = 0
  for (const args of argumentLists) {
    if (reachedBySpread(args)) {
      unknown ??= 'stated-omission-spread-argument'
      continue
    }
    const argument = args[index]
    if (!argument) continue
    const type = argumentType(argument)
    if (!type || isUnusableEvidence(type) || (type.flags & ts.TypeFlags.Unknown) !== 0) {
      unknown ??= 'stated-omission-argument-unresolved'
      untyped += 1
      // An untyped whole can still have a typed branch that disproves the
      // statement: fastify's `requestIdHeader` is `typeof h === 'string' ? ...
      // : (h === true && 'request-id')`, `any` as a whole (it reads `options`)
      // and `false | "request-id"` on the branch that answers when no header
      // is configured. The rule below then leaves the cell `any`.
      for (const branch of valueBranchesOf(checker, argument)) {
        const branchType = checker.getTypeAtLocation(branch)
        if (isUnusableEvidence(branchType) || (branchType.flags & ts.TypeFlags.Unknown) !== 0) continue
        if (!checker.isTypeAssignableTo(branchType, stated)) outside.push(checker.getBaseTypeOfLiteralType(branchType))
      }
      continue
    }
    if (holdsUntypedArguments && leavesStatedObjectMemberUntyped(checker, type, stated)) {
      unknown ??= 'stated-omission-argument-unresolved'
      untyped += 1
      continue
    }
    typed += 1
    // Structural assignability is not carriage for a class instance: ajv's
    // `block$data(valid: Name, ...)` is called with `nil`, a `_Code` -- a
    // sibling class the checker accepts for its shape, and a different
    // nominal carrier to this compiler (`isForeignClassInstance`).
    if (!checker.isTypeAssignableTo(type, stated) || isForeignClassInstance(checker, type, stated))
      outside.push(checker.getBaseTypeOfLiteralType(type))
  }
  // Every caller hands a value no census can type to a plain object
  // statement (`holdsUntypedArguments`): fastify's `router.setup(options)`
  // states `FastifyServerOptions` and receives the `Object.assign` copy
  // `processOptions` has since written a logger instance into. The only
  // faithful carrier for such an argument is the box it already is.
  if (holdsUntypedArguments && untyped > 0 && typed === 0 && outside.length === 0 && unknown === 'stated-omission-argument-unresolved')
    return { type: checker.getAnyType() }
  if (untypedArgumentsOnly) return null
  if (!omitted && outside.length === 0) return null
  // A statement a visible caller disproves says nothing about an argument no
  // census can type, so the cell holds whatever that argument holds.
  if (unknown !== null)
    return outside.length > 0 && unknown === 'stated-omission-argument-unresolved' ? { type: checker.getAnyType() } : { refused: unknown }
  const joined = outside.length === 0 ? stated : unionTypeOf(checker, [stated, ...outside])
  if (joined === null) return { refused: 'stated-parameter-union-unavailable' }
  return { type: omitted ? checker.getNullableType(joined, ts.TypeFlags.Undefined) : joined }
}
