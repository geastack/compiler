import ts from 'typescript'
import { isAmbientDeclaration } from '../ambient.js'
import { unwrapErasedExpression } from './producers/erasure.js'
import { declarationStatesHostInert } from './host-effect-contracts.js'
import { everyKey, namedKey, numericKeys, numericLiteralKey, programSymbolKeys, type MutationKey } from './host-mutation-keys.js'

/** `__proto__` is never an ordinary key: a [[Set]] of it runs the accessor that replaces a prototype. */
export const keyOfName = (name: string): MutationKey => (name === '__proto__' ? everyKey : namedKey(name))

/**
 * Whether a key expression is a PROGRAM-DECLARED unique symbol -- one this
 * program made with `Symbol()`, not one the standard library declares on
 * `SymbolConstructor`.
 *
 * This describes a checker type, not a runtime origin proof. Casts can assign
 * a well-known symbol to a program's unique-symbol declaration. Consumers
 * proving absence must authenticate the actual initializer and stock factory.
 *
 * ⛔ Standard-library-declared is the whole guard, in both directions.
 * `X.prototype[Symbol.iterator] = f` genuinely redefines intrinsic behavior
 * under a non-string key, so it must stay `every`. A bare `symbol`-typed key
 * (not `unique`) names an unknown symbol and fails closed the same way.
 *
 */
export const isProgramDeclaredSymbolKey = (type: ts.Type): boolean => {
  const members = type.isUnion() ? type.types : [type]
  return (
    members.length > 0 &&
    members.every(
      (member) =>
        (member.flags & ts.TypeFlags.UniqueESSymbol) !== 0 &&
        ((member as ts.UniqueESSymbolType).symbol.declarations ?? []).length > 0 &&
        !((member as ts.UniqueESSymbolType).symbol.declarations ?? []).some((declaration) => declaration.getSourceFile().hasNoDefaultLib)
    )
  )
}

/**
 * Which keys a write names, for the host-mutation census.
 *
 * Every answer here is a SUPERSET of the keys the write can reach at run
 * time; `every` is the answer whenever this reader cannot prove less. Three
 * sources are trusted and nothing else:
 *
 * - the syntax: a property name, a string literal, a numeric literal (whose
 *   key is its canonical `ToString`, so `o[1.50]` is "1.5");
 * - the number representation: an expression the checker types as `number`
 *   (or a number literal type, or a numeric enum) is carried as a native
 *   double, so its key is some `ToString(Number)` -- the NUMERIC domain, not
 *   an array index, since `-1`, `1.5` and `NaN` are numbers too.
 * - the boolean representation: an expression the checker types as `boolean`
 *   is carried as a native two-state scalar, so its key is exactly "true" or
 *   "false" (`ToPropertyKey` of a boolean is `ToString(Boolean)`).
 *
 * A string-literal TYPE is deliberately not trusted: nothing in the compiled
 * representation stops an `any` from carrying "zzz" into a cell typed `'a'`.
 * A caller-supplied `computedKeysOf` authority may prove a finite key set;
 * that is its claim to justify, and `null` from it keeps the key unknown.
 * (The census's own authority is `host-mutation-computed-keys.ts`.)
 */
export const createMutationKeyReader = (
  checker: ts.TypeChecker,
  computedKeysOf: (key: ts.Expression) => readonly MutationKey[] | null,
  publishedTypeAt: (key: ts.Expression) => ts.Type = (key) => checker.getTypeAtLocation(key),
  /** Authenticates the actual stock Symbol initializer and records factory-integrity requirements. */
  programSymbolAt: (key: ts.Expression) => boolean = () => false
): {
  readonly keysOfKeyExpression: (expression: ts.Expression | undefined) => readonly MutationKey[]
  readonly keysOfAccess: (access: ts.PropertyAccessExpression | ts.ElementAccessExpression) => readonly MutationKey[]
  readonly keysOfPropertyName: (name: ts.PropertyName) => readonly MutationKey[]
} => {
  const numericType = (type: ts.Type): boolean =>
    type.isUnion()
      ? type.types.every(numericType)
      : (type.flags & ts.TypeFlags.NumberLike) !== 0 && (type.flags & ~ts.TypeFlags.NumberLike) === 0
  /**
   * Named keys for a checker type this reader trusts completely: the
   * boolean domain, and nothing wider. `ToPropertyKey` of `true`/`false` is
   * exactly the string "true"/"false" (ECMA-262 7.1.14 via
   * ToString(Boolean)), so a `boolean`-typed key names exactly those two
   * strings -- not an approximation, the complete set. This is trustworthy
   * for the same reason the numeric domain above is: `primitiveCarrier`
   * (`src/representation/primitives.ts`) gives `boolean` its own native
   * scalar domain, so the COMPILED storage for a boolean-typed cell can only
   * ever hold one of two bit patterns, independent of whatever TypeScript's
   * structural assignability allowed elsewhere.
   *
   * A string-literal TYPE is deliberately NOT extended the same trust, even
   * though it looks like the same shape of fact. `primitiveCarrier` gives
   * `string` -- literal or not -- the one generic `{ kind: 'string' }`
   * carrier with no narrower storage, and TypeScript lets an `any` flow into
   * a `'a' | 'b'`-typed slot (a parameter, a field) with zero diagnostic.
   * Trusting the checker's literal-union TYPE there would let a value the
   * compiled representation cannot distinguish from "any string" certify as
   * bounded to `{'a','b'}` -- the exact hole the class doc above already
   * calls out ("nothing in the compiled representation stops an `any` from
   * carrying 'zzz' into a cell typed `'a'`"). A `const` bound once to a
   * literal initializer is a DIFFERENT, sound fact (no other write exists to
   * contaminate), and it is already covered -- by construction, not by
   * naming it here -- through the `computedKeysOf` value-flow authority.
   */
  const namedKeysOfLiteralType = (type: ts.Type): readonly MutationKey[] | null => {
    if (type.isUnion()) {
      const keys: MutationKey[] = []
      for (const member of type.types) {
        const memberKeys = namedKeysOfLiteralType(member)
        if (memberKeys === null) return null
        keys.push(...memberKeys)
      }
      return keys.some((key) => key.kind === 'every') ? null : keys
    }
    if (type.flags & ts.TypeFlags.BooleanLiteral) return [namedKey(checker.typeToString(type) === 'true' ? 'true' : 'false')]
    if (type.flags & ts.TypeFlags.Boolean) return [namedKey('true'), namedKey('false')]
    return null
  }
  const keysOfKeyExpression = (expression: ts.Expression | undefined): readonly MutationKey[] => {
    if (!expression) return [everyKey]
    const current = unwrapErasedExpression(expression)
    if (ts.isStringLiteralLike(current)) return [keyOfName(current.text)]
    if (ts.isNumericLiteral(current)) {
      const key = numericLiteralKey(current.text)
      return [key === null ? numericKeys : namedKey(key)]
    }
    if (
      ts.isPrefixUnaryExpression(current) &&
      current.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(unwrapErasedExpression(current.operand))
    ) {
      const key = numericLiteralKey(`-${(unwrapErasedExpression(current.operand) as ts.NumericLiteral).text}`)
      return [key === null ? numericKeys : namedKey(key)]
    }
    if (ts.isConditionalExpression(current)) {
      const keys = [...keysOfKeyExpression(current.whenTrue), ...keysOfKeyExpression(current.whenFalse)]
      return keys.some((key) => key.kind === 'every') ? [everyKey] : keys
    }
    const type = publishedTypeAt(current)
    if (numericType(type)) return [numericKeys]
    // Keep program-created symbol writes visible to inherited-symbol queries,
    // while preserving the distinct string and well-known-symbol domains.
    if (programSymbolAt(current)) return [programSymbolKeys]
    const literalKeys = namedKeysOfLiteralType(type)
    if (literalKeys) return literalKeys
    const computed = computedKeysOf(current)
    return !computed || computed.some((key) => key.kind === 'every') ? [everyKey] : computed
  }
  const keysOfAccess = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression): readonly MutationKey[] =>
    ts.isPropertyAccessExpression(access) ? [keyOfName(access.name.text)] : keysOfKeyExpression(access.argumentExpression)
  const keysOfPropertyName = (name: ts.PropertyName): readonly MutationKey[] => {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isPrivateIdentifier(name)) return [keyOfName(name.text)]
    if (ts.isNumericLiteral(name)) {
      const key = numericLiteralKey(name.text)
      return [key === null ? numericKeys : namedKey(key)]
    }
    if (ts.isComputedPropertyName(name)) return keysOfKeyExpression(name.expression)
    return [everyKey]
  }
  return { keysOfKeyExpression, keysOfAccess, keysOfPropertyName }
}

/**
 * Keys a host or library ACCESSOR owns. A write of such a key through an
 * unknown receiver may run that accessor, whose effect no body states, so
 * the census treats the key as unknown. `__proto__` is always one: it is
 * `Object.prototype`'s accessor, which the standard library does not
 * declare, and running it replaces a prototype.
 *
 * A setter covered by `@gea-host-inert` states its effect and is not listed;
 * a key is listed when ANY declaration of a setter by that name is uncovered.
 */
export const hostAccessorNamesOf = (declarationFiles: readonly ts.SourceFile[], files: readonly ts.SourceFile[]): ReadonlySet<string> => {
  const names = new Set<string>(['__proto__'])
  for (const file of declarationFiles) for (const name of setterNamesOf(file, false)) names.add(name)
  for (const file of files) if (!file.isDeclarationFile) for (const name of setterNamesOf(file, true)) names.add(name)
  return names
}

/**
 * The names of the uncovered setters one file declares, in encounter order.
 *
 * A pure function of the tree -- `declarationStatesHostInert` reads only the
 * declaration and its own JSDoc -- and a declaration file's tree is shared
 * across compiles (`shared-declaration-files.ts`), so the whole-file walk is
 * kept per file instead of repeated for the same standard library every compile.
 */
const setterNames = new WeakMap<ts.SourceFile, { readonly any: readonly string[]; readonly ambient: readonly string[] }>()
const setterNamesOf = (file: ts.SourceFile, ambientOnly: boolean): readonly string[] => {
  const known = setterNames.get(file)
  if (known !== undefined) return ambientOnly ? known.ambient : known.any
  const any: string[] = []
  const ambient: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isSetAccessorDeclaration(node) && !declarationStatesHostInert(node)) {
      const name = node.name
      if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
        any.push(name.text)
        if (isAmbientDeclaration(node)) ambient.push(name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  const held = { any, ambient }
  setterNames.set(file, held)
  return ambientOnly ? held.ambient : held.any
}
