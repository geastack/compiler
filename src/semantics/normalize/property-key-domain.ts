import ts from '#typescript'
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
const isNumberType = (type: ts.Type): boolean =>
  (type.flags & ts.TypeFlags.NumberLike) !== 0 && (type.flags & ~ts.TypeFlags.NumberLike) === 0
const isStringDomain = (domain: PropertyKeyDomain): boolean =>
  domain.kind === 'literal' || domain.kind === 'concat' || (domain.kind === 'union' && domain.members.every(isStringDomain))

/**
 * `reachable` for a caller that counts every write. A module-level function on
 * purpose: an inline `() => true` shares its context with every other closure
 * of the function that writes it, and key domains are remembered with the flow
 * index -- one such arrow kept half a gigabyte of a proof's authority alive.
 */
export const everyWriteReachable = (): boolean => true

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
  // One domain per type, not per asking expression: a parameter typed as a
  // union of hundreds of literal keys was rebuilt literal by literal for every
  // reference to it, and the copies were what this table held.
  const typeDomains = new Map<ts.Type, PropertyKeyDomain>()
  const typeDomain = (type: ts.Type): PropertyKeyDomain => {
    const known = typeDomains.get(type)
    if (known) return known
    const domain: PropertyKeyDomain = type.isUnion()
      ? { kind: 'union', members: type.types.map(typeDomain) }
      : type.isStringLiteral()
        ? literal(type.value)
        : isNumberType(type)
          ? numeric
          : unknown
    typeDomains.set(type, domain)
    return domain
  }
  // Every reference to a variable answers the union of its writes, so it is
  // built once per declaration. Entered as `unknown` first for the same reason
  // `domainOf` does: a write that reads the variable itself is a cycle.
  const variables = new Map<ts.VariableDeclaration, PropertyKeyDomain>()
  const variableDomain = (declaration: ts.VariableDeclaration): PropertyKeyDomain => {
    const known = variables.get(declaration)
    if (known) return known
    variables.set(declaration, unknown)
    const writes = flow.writesToDeclaration(declaration).filter((write) => reachable(write.site) && write.slot === 'whole')
    const domain: PropertyKeyDomain =
      writes.length > 0
        ? { kind: 'union', members: writes.map((write) => (write.value === null ? unknown : domainOf(write.value))) }
        : unknown
    variables.set(declaration, domain)
    return domain
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
    // A key the checker types as a number is carried as one, whatever spelled
    // it: a paging buffer's `page.buffer[o] = b`, with `o` from `i & mask` and
    // `o += this.pageOffset`, stores through a numeric key and so can never
    // name `pageOffset` -- none of the syntax below states that.
    else if (isNumberType(checker.getTypeAtLocation(current))) result = numeric
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
      if (declaration && ts.isVariableDeclaration(declaration)) result = variableDomain(declaration)
      else if (ts.isIdentifier(current) && declaration && ts.isParameter(declaration)) {
        result = typeDomain(parameterTypeAt(current))
      }
    }
    domains.set(current, result)
    return result
  }
  // Nothing is remembered across questions. A consumer asks every keyed write
  // against every member name, and its own answers are memoized per name; a
  // table here kept one entry per (write, name) -- and, for a concatenation,
  // every prefix and suffix of every name it split -- for as long as the flow
  // index lived, half a gigabyte on a large program. `domainMayName` remembers
  // a concatenation's parts for one question only.
  const mayName = domainMayName
  return { of: domainOf, mayName }
}

/** One query's answer. The parts are remembered for this query alone: nested concatenations split the same slices repeatedly. */
const domainMayName = (domain: PropertyKeyDomain, name: string): boolean => {
  const parts = new Map<PropertyKeyDomain, Map<string, boolean>>()
  const matches = (part: PropertyKeyDomain, text: string): boolean => {
    switch (part.kind) {
      case 'unknown':
        return true
      case 'literal':
        return part.value === text
      case 'number':
        return String(Number(text)) === text
      case 'union':
        return part.members.some((member) => matches(member, text))
      case 'concat': {
        let texts = parts.get(part)
        if (texts === undefined) parts.set(part, (texts = new Map()))
        const known = texts.get(text)
        if (known !== undefined) return known
        let result = false
        for (let split = 0; split <= text.length && !result; split++)
          result = matches(part.left, text.slice(0, split)) && matches(part.right, text.slice(split))
        texts.set(text, result)
        return result
      }
    }
  }
  return matches(domain, name)
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
 * The interior rule is what a cache keyed `index + '_' + indexArray` -- two
 * numbers around an underscore -- needs. The edges are unspelled, so the edge
 * rule alone kept this write as a possible numeric key on the host object it
 * was written to, refused that object's numeric-absence proof, and left an
 * unrelated `ctx[ p ]` constant lookup on the same object -- and every value
 * downstream of it -- dynamic.
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
