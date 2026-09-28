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
 * A DEFAULTED parameter is not this case (the default answers the omission),
 * nor an OPTIONAL one (`withDeclaredAbsence` already joins the absence), nor a
 * rest or destructured one.
 */

export type OmittedStatedParameterAnswer = { readonly type: ts.Type } | { readonly refused: string }

/** The JSDoc statement of a JavaScript parameter this rule may widen, or `null`. */
export const omissionStatedTypeOf = (checker: ts.TypeChecker, parameter: ts.ParameterDeclaration): ts.Type | null => {
  if ((parameter.flags & ts.NodeFlags.JavaScriptFile) === 0) return null
  if (parameter.dotDotDotToken || parameter.initializer || !ts.isIdentifier(parameter.name)) return null
  if (checker.isOptionalParameter(parameter)) return null
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
  return stated
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
  argumentType: (argument: ts.Expression) => ts.Type | null
): OmittedStatedParameterAnswer | null => {
  // `new F` with no argument list passes nothing at all.
  const argumentLists = calls.map((call) => argumentsOf(call) ?? [])
  // A spread at or before the position may or may not reach it.
  const reachedBySpread = (args: readonly ts.Expression[]): boolean => args.slice(0, index + 1).some(ts.isSpreadElement)
  const omitted = argumentLists.some((args) => args[index] === undefined && !reachedBySpread(args))
  const outside: ts.Type[] = []
  let unknown: string | null = null
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
      continue
    }
    // Structural assignability is not carriage for a class instance: ajv's
    // `block$data(valid: Name, ...)` is called with `nil`, a `_Code` -- a
    // sibling class the checker accepts for its shape, and a different
    // nominal carrier to this compiler (`isForeignClassInstance`).
    if (!checker.isTypeAssignableTo(type, stated) || isForeignClassInstance(checker, type, stated))
      outside.push(checker.getBaseTypeOfLiteralType(type))
  }
  if (!omitted && outside.length === 0) return null
  // A statement a visible caller disproves says nothing about an argument no
  // census can type, so the cell holds whatever that argument holds.
  if (unknown !== null)
    return outside.length > 0 && unknown === 'stated-omission-argument-unresolved' ? { type: checker.getAnyType() } : { refused: unknown }
  const joined = outside.length === 0 ? stated : unionTypeOf(checker, [stated, ...outside])
  if (joined === null) return { refused: 'stated-parameter-union-unavailable' }
  return { type: omitted ? checker.getNullableType(joined, ts.TypeFlags.Undefined) : joined }
}
