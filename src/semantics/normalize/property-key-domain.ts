import ts from 'typescript'
import type { ValueFlowIndex } from './flow/model.js'
import { unwrapErasedExpression } from './producers/erasure.js'
import { isCanonicalNumericKey } from './host-mutation-keys.js'

/** An over-approximation of ToPropertyKey's string results; unknown never excludes a name. */
export type PropertyKeyDomain =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'number' }
  | { readonly kind: 'union'; readonly members: readonly PropertyKeyDomain[] }
  | { readonly kind: 'concat'; readonly left: PropertyKeyDomain; readonly right: PropertyKeyDomain }

const unknown: PropertyKeyDomain = { kind: 'unknown' }
const numeric: PropertyKeyDomain = { kind: 'number' }
const literal = (value: string): PropertyKeyDomain => ({ kind: 'literal', value })
const concat = (left: PropertyKeyDomain, right: PropertyKeyDomain): PropertyKeyDomain => ({ kind: 'concat', left, right })
const isStringDomain = (domain: PropertyKeyDomain): boolean =>
  domain.kind === 'literal' || domain.kind === 'concat' || (domain.kind === 'union' && domain.members.every(isStringDomain))

export const createPropertyKeyDomains = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  reachable: (node: ts.Node) => boolean,
  parameterTypeAt: (parameter: ts.Expression) => ts.Type = (parameter) => checker.getTypeAtLocation(parameter)
): {
  readonly of: (expression: ts.Expression) => PropertyKeyDomain
  readonly mayName: (domain: PropertyKeyDomain, name: string) => boolean
} => {
  const domains = new Map<ts.Expression, PropertyKeyDomain>()
  const typeDomain = (type: ts.Type): PropertyKeyDomain => {
    if (type.isUnion()) return { kind: 'union', members: type.types.map(typeDomain) }
    if (type.isStringLiteral()) return literal(type.value)
    if ((type.flags & ts.TypeFlags.NumberLike) !== 0 && (type.flags & ~ts.TypeFlags.NumberLike) === 0) return numeric
    return unknown
  }
  const domainOf = (expression: ts.Expression): PropertyKeyDomain => {
    const current = unwrapErasedExpression(expression)
    const known = domains.get(current)
    if (known) return known
    // Cyclic aliases provide no restriction. This placeholder also bounds
    // recursive initializers without mistaking an empty cycle for evidence.
    domains.set(current, unknown)
    let result: PropertyKeyDomain = unknown
    if (ts.isStringLiteralLike(current)) result = literal(current.text)
    else if (ts.isNumericLiteral(current)) result = numeric
    else if (ts.isTemplateExpression(current)) {
      result = literal(current.head.text)
      for (const span of current.templateSpans) result = concat(concat(result, domainOf(span.expression)), literal(span.literal.text))
    } else if (ts.isConditionalExpression(current)) {
      result = { kind: 'union', members: [domainOf(current.whenTrue), domainOf(current.whenFalse)] }
    } else if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = domainOf(current.left)
      const right = domainOf(current.right)
      // A string assertion does not change numeric addition into concatenation.
      if (isStringDomain(left) || isStringDomain(right)) result = concat(left, right)
      else if (left.kind === 'number' && right.kind === 'number') result = numeric
    } else {
      const declaration = ts.isIdentifier(current) ? flow.targetOf(current)?.declaration : null
      if (declaration && ts.isVariableDeclaration(declaration)) {
        const writes = flow.writesToDeclaration(declaration).filter((write) => reachable(write.site) && write.slot === 'whole')
        result =
          writes.length > 0
            ? { kind: 'union', members: writes.map((write) => (write.value === null ? unknown : domainOf(write.value))) }
            : unknown
      } else if (ts.isIdentifier(current) && declaration && ts.isParameter(declaration)) {
        result = typeDomain(parameterTypeAt(current))
      }
    }
    domains.set(current, result)
    return result
  }
  const matches = new Map<PropertyKeyDomain, Map<string, boolean>>()
  const mayName = (domain: PropertyKeyDomain, name: string): boolean => {
    let names = matches.get(domain)
    if (!names) {
      names = new Map()
      matches.set(domain, names)
    }
    const known = names.get(name)
    if (known !== undefined) return known
    let result: boolean
    switch (domain.kind) {
      case 'unknown':
        result = true
        break
      case 'literal':
        result = domain.value === name
        break
      case 'number':
        result = String(Number(name)) === name
        break
      case 'union':
        result = domain.members.some((member) => mayName(member, name))
        break
      case 'concat': {
        result = false
        for (let split = 0; split <= name.length; split++) {
          if (mayName(domain.left, name.slice(0, split)) && mayName(domain.right, name.slice(split))) {
            result = true
            break
          }
        }
        break
      }
    }
    names.set(name, result)
    return result
  }
  return { of: domainOf, mayName }
}

const domainEdgeLiteral = (domain: PropertyKeyDomain, side: 'left' | 'right'): string | null =>
  domain.kind === 'literal' ? domain.value : domain.kind === 'concat' ? domainEdgeLiteral(domain[side], side) : null

/**
 * Every character a canonical numeric string can contain: the decimal and
 * exponent forms (`-1.5e+21`), `Infinity`, `-Infinity` and `NaN`. A spelled
 * fragment holding any other character cannot be a substring of one, wherever
 * it sits in the concatenation.
 */
const CANONICAL_NUMERIC_ALPHABET = /^[-+.\deINafinty]*$/
const domainLiteralPieces = (domain: PropertyKeyDomain): string[] =>
  domain.kind === 'literal'
    ? [domain.value]
    : domain.kind === 'concat'
      ? [...domainLiteralPieces(domain.left), ...domainLiteralPieces(domain.right)]
      : []

/**
 * Whether ANY canonical numeric string lies in `domain` -- `mayName` asked of
 * every such name at once. Each starts with `-`, a digit, `I` (Infinity) or `N`
 * (NaN) and ends with a digit, `y` or `N`, and every spelled piece between
 * must be a substring of such a name; an unknown domain may name anything.
 *
 * The interior rule is what three's `WebGLUniformsGroups.js` needs: its cache
 * is keyed `index + '_' + indexArray`, two numbers around an underscore. The
 * edges are unspelled, so the edge rule alone kept this write as a possible
 * numeric key on the WebGL context, refused the context's numeric-absence
 * proof, and left `WebGLUtils.convert`'s `gl[ p ]` fallback -- and every
 * `glFormat`/`glType` downstream of it -- dynamic.
 */
export const domainMayNameNumeric = (domain: PropertyKeyDomain): boolean => {
  switch (domain.kind) {
    case 'literal':
      return isCanonicalNumericKey(domain.value)
    case 'union':
      return domain.members.some(domainMayNameNumeric)
    case 'concat': {
      const lead = domainEdgeLiteral(domain, 'left')
      const trail = domainEdgeLiteral(domain, 'right')
      if (lead && !/^[-\dIN]/.test(lead)) return false
      if (trail && !/[\dyN]$/.test(trail)) return false
      return domainLiteralPieces(domain).every((piece) => CANONICAL_NUMERIC_ALPHABET.test(piece))
    }
    default:
      return true
  }
}
