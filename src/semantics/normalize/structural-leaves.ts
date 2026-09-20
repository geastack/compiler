import ts from 'typescript'
import type { PropertyKeyShape, StructuralShape } from '../model/structural-types.js'
import type { IdentityTable } from './identities.js'

/**
 * A `ts.Type` that is a leaf: it maps straight to its shape with no walk.
 *
 * These three answers share one property that earns them a file of their own --
 * none of them can recur. A primitive, a literal, and a property key are
 * terminal by construction, so none needs the interning table, the in-progress
 * set, or the self-reference machinery the rest of the mapper is built around.
 * Keeping them out of that closure keeps the fact that they cannot participate
 * in a cycle visible in the code rather than merely true of it.
 */

export const primitiveFor = (type: ts.Type): StructuralShape | null => {
  const flags = type.flags
  if (flags & ts.TypeFlags.Never) return { kind: 'primitive', primitive: 'never' }
  if (flags & ts.TypeFlags.Void) return { kind: 'primitive', primitive: 'void' }
  if (flags & ts.TypeFlags.Undefined) return { kind: 'primitive', primitive: 'undefined' }
  if (flags & ts.TypeFlags.Null) return { kind: 'primitive', primitive: 'null' }
  if (flags & ts.TypeFlags.BooleanLiteral) return { kind: 'primitive', primitive: 'boolean' }
  if (flags & ts.TypeFlags.Boolean) return { kind: 'primitive', primitive: 'boolean' }
  if (flags & ts.TypeFlags.Number) return { kind: 'primitive', primitive: 'number' }
  if (flags & ts.TypeFlags.BigInt) return { kind: 'primitive', primitive: 'bigint' }
  if (flags & ts.TypeFlags.String) return { kind: 'primitive', primitive: 'string' }
  // A template-literal type (`` `${number}%` ``) and a string-mapping type
  // (`Uppercase<T>`) are constraints on which strings a value may be, not a
  // separate kind of value: every inhabitant is a string, and the constraint is
  // checked by the checker and then has nothing left to say about storage. They
  // are deliberately not `literal` shapes -- a literal names one exact value a
  // union can be discriminated on, and these name a set -- so the honest answer
  // is the primitive they inhabit. Without this a `style={{ width: `${n}%` }}`
  // reaches representation as an unmodelled checker type and takes the whole
  // enclosing object literal down with it.
  if (flags & (ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) return { kind: 'primitive', primitive: 'string' }
  if (flags & ts.TypeFlags.ESSymbol) return { kind: 'primitive', primitive: 'symbol' }
  if (flags & ts.TypeFlags.Unknown) return { kind: 'primitive', primitive: 'unknown' }
  if (flags & ts.TypeFlags.Any) return { kind: 'primitive', primitive: 'any' }
  return null
}

export const literalFor = (type: ts.Type): StructuralShape | null => {
  if (type.isStringLiteral()) return { kind: 'literal', primitive: 'string', text: type.value }
  if (type.isNumberLiteral()) return { kind: 'literal', primitive: 'number', text: String(type.value) }
  if (type.flags & ts.TypeFlags.BigIntLiteral) {
    const literal = (type as ts.BigIntLiteralType).value
    return { kind: 'literal', primitive: 'bigint', text: `${literal.negative ? '-' : ''}${literal.base10Value}` }
  }
  return null
}

/**
 * The declaration a symbol-named member's key is anchored to: the SYMBOL's own
 * declaration, reached through the member's computed name.
 *
 * `class C { [GEA_DISPOSER]: D }` declares a member whose key is
 * `GEA_DISPOSER`, and the member declaration is not that key -- it is a
 * *use* of it. Anchoring on the member would give two classes that declare
 * the same symbol-named member two different keys, and `keyof.ts` already
 * assumes the opposite: it turns a member key straight into
 * `{ kind: 'unique-symbol', declaration }`, which `structural.ts`'s own
 * `UniqueESSymbol` branch mints from the SYMBOL's declaration. Two spellings
 * of one identity is exactly the drift this compiler refuses elsewhere, and
 * here it is load-bearing: `records.ts` names the struct member
 * `gea_sym_<declaration>` while `producers/properties.ts` resolves
 * `this[GEA_DISPOSER]` through the same text, so a disagreement is a field
 * write that lands on a member no read finds.
 *
 * `null` when the member has no computed name to resolve through -- a
 * synthesized or late-bound symbol with no declaration -- and the caller falls
 * back to the member's own declaration, which is still a stable identity, just
 * a per-declaration one.
 */
export const symbolKeyDeclarationOf = (checker: ts.TypeChecker, identities: IdentityTable, member: ts.Symbol): ts.Declaration | null => {
  for (const declaration of member.getDeclarations() ?? []) {
    const name = (declaration as ts.NamedDeclaration).name
    if (!name || !ts.isComputedPropertyName(name)) continue
    const keySymbol = checker.getSymbolAtLocation(name.expression)
    // Through `identities`, never `keySymbol.getDeclarations()` directly: the
    // name expression is an imported identifier in every real case, so the
    // symbol at that location is the IMPORT SPECIFIER and its first
    // declaration is the import statement in the consuming file. Two files
    // importing one symbol would then anchor its key on two different
    // declarations. `declarationOfSymbol` follows the alias to the `const`
    // itself, which is exactly the anchor `structural.ts`'s `UniqueESSymbol`
    // branch mints for the key expression's own type.
    const resolved = keySymbol ? identities.declarationOfSymbol(keySymbol) : null
    if (resolved) return resolved
  }
  return null
}

/**
 * The shape of the property key a symbol declares.
 *
 * A well-known symbol member arrives with the checker's own `__@`-prefixed
 * name, which is not the key -- the key is the symbol's declaration, so the
 * shape cites that instead of the mangled spelling. A numeric name is a number
 * key only when it round-trips exactly, so `'01'` and `'1.5'` stay string keys.
 */
export const createLeafKeying = (identities: IdentityTable, checker: ts.TypeChecker) => {
  const keyOfSymbol = (symbol: ts.Symbol): PropertyKeyShape | null => {
    const name = symbol.getName()
    if (name.startsWith('__@')) {
      const declaration = symbolKeyDeclarationOf(checker, identities, symbol) ?? identities.declarationOfSymbol(symbol)
      return declaration ? { kind: 'symbol', declaration: identities.declarationIdOf(declaration) } : null
    }
    const asIndex = Number(name)
    if (String(asIndex) === name && Number.isInteger(asIndex) && asIndex >= 0) return { kind: 'number', value: asIndex }
    return { kind: 'string', value: name }
  }
  return { keyOfSymbol }
}
