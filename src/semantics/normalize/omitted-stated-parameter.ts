import ts from 'typescript'
import { annotationStatesNothing, containsUnstatedPosition, isUnusableEvidence, jsDocTypeStatesNothing } from './derived-expression-type.js'

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
 * `undefined` when at least one caller omits the argument and every argument
 * a caller does pass is a value the statement admits. A passed value outside
 * the statement is a disagreement this rule does not paper over, and an
 * argument a spread may or may not supply is unknown; both refuse. A caller
 * set the census cannot close does NOT: a caller it cannot see is held to the
 * statement exactly as it is when this rule is silent, so it adds nothing the
 * widened type lacks, and cannot remove the omission a visible caller makes.
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
 * `stated | undefined` when some caller in the (already closed) caller set
 * omits the argument at `index`.
 *
 * `null` when no caller provably omits it -- every caller passes it, or there
 * is no attributed caller at all -- so the statement stands as written and
 * this rule has nothing to say (and nothing to refuse). Omission is decided
 * first for that reason: only a parameter some call really leaves out is
 * this rule's business.
 */
export const statedParameterWithOmission = (
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
  if (!argumentLists.some((args) => args[index] === undefined && !reachedBySpread(args))) return null
  for (const args of argumentLists) {
    if (reachedBySpread(args)) return { refused: 'stated-omission-spread-argument' }
    const argument = args[index]
    if (!argument) continue
    const type = argumentType(argument)
    if (!type || isUnusableEvidence(type) || (type.flags & ts.TypeFlags.Unknown) !== 0)
      return { refused: 'stated-omission-argument-unresolved' }
    if (!checker.isTypeAssignableTo(type, stated)) return { refused: 'stated-omission-argument-not-assignable' }
  }
  return { type: checker.getNullableType(stated, ts.TypeFlags.Undefined) }
}
