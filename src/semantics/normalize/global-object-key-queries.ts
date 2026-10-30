import ts from '#typescript'
import type { ProducerContext } from './producer-context.js'
import { unwrapErasedExpression } from './producers/erasure.js'

/** Object and Reflect members that ask an object about one key (`true`) or about every own key (`false`). */
const staticKeyQueries: Readonly<Record<'Object' | 'Reflect', ReadonlyMap<string, boolean>>> = {
  Object: new Map([
    ['hasOwn', true],
    ['getOwnPropertyDescriptor', true],
    ['keys', false],
    ['getOwnPropertyNames', false],
    ['getOwnPropertySymbols', false],
    ['getOwnPropertyDescriptors', false],
    ['entries', false],
    ['values', false]
  ]),
  Reflect: new Map([
    ['has', true],
    ['getOwnPropertyDescriptor', true],
    ['ownKeys', false]
  ])
}

/** Object.prototype members that ask their receiver about one key. */
const prototypeKeyQueries: ReadonlySet<string> = new Set(['hasOwnProperty', 'propertyIsEnumerable'])

/**
 * The object a standard-library key query asks, and which argument is its key
 * (`null` when it reads every own key).
 *
 * Identified by the declaration the checker resolved the call to, so a held
 * builtin (`const has = Object.hasOwn`) is the same query, and not by the
 * host-mutation census's proof that the builtin is still installed
 * (`intrinsicPropertyCallOf`): a call that may be the builtin is a query here,
 * and a program that replaced the builtin only makes the call refuse where it
 * might have answered.
 */
export const builtinKeyQueryOf = (
  context: Pick<ProducerContext, 'checker' | 'isStandardLibraryDeclaration'>,
  call: ts.CallExpression
): { readonly object: ts.Expression; readonly keyArgument: number | null } | null => {
  const { checker } = context
  const declaration = checker.getResolvedSignature(call)?.declaration
  if (!declaration || ts.isJSDocSignature(declaration) || !declaration.name || !ts.isIdentifier(declaration.name)) return null
  if (context.isStandardLibraryDeclaration?.(declaration) !== true) return null
  const name = declaration.name.text
  const container = ts.isModuleBlock(declaration.parent) ? declaration.parent.parent : declaration.parent
  const owner =
    ts.isInterfaceDeclaration(container) || ts.isModuleDeclaration(container) ? checker.getSymbolAtLocation(container.name) : undefined
  // The standard library's own declarations, looked up from the global scope.
  const ownedBy = (global: string, meaning: ts.SymbolFlags): boolean =>
    owner !== undefined && owner === checker.resolveName(global, undefined, meaning, false)
  if (ownedBy('Object', ts.SymbolFlags.Interface)) {
    // `o.hasOwnProperty(k)` asks its receiver.
    const callee = unwrapErasedExpression(call.expression)
    const receiver = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? callee.expression : null
    return prototypeKeyQueries.has(name) && receiver !== null ? { object: receiver, keyArgument: 0 } : null
  }
  const takesKey = ownedBy('ObjectConstructor', ts.SymbolFlags.Interface)
    ? staticKeyQueries.Object.get(name)
    : ownedBy('Reflect', ts.SymbolFlags.Namespace)
      ? staticKeyQueries.Reflect.get(name)
      : undefined
  const object = call.arguments[0]
  if (takesKey === undefined || object === undefined || ts.isSpreadElement(object)) return null
  return { object, keyArgument: takesKey ? 1 : null }
}

/**
 * Why a presence or own-key query on a value that may be the global object
 * cannot be answered, or `null` when the global object's property table is the
 * whole answer.
 *
 * The compiled global object is one open native dictionary holding only the
 * properties the program installs at run time (`producers/references.ts`'s
 * `global-this` reference). Every global binding -- `Math`, `Intl`, `console`,
 * a script's `var` -- keeps its own cell outside that table, which is why a
 * read `globalThis.X` is routed to the cell (`properties.ts`'s
 * `hostGlobalMemberDeclarationOf`). A key query asks the table and cannot see
 * those cells: `'Math' in globalThis` and `Object.hasOwn(globalThis, 'Intl')`
 * answered `false` where every engine answers `true`. Answering `true` instead
 * would need a fact this compiler does not have: which of the standard
 * library's globals the target actually provides (`Intl`'s bare read is
 * refused as a global no host defines).
 *
 * The table is still the whole answer for a key that names no global binding:
 * a key nothing declares (a bare read of it has no cell either,
 * `unresolvable-names.ts`) and a key the host states absent
 * (`absent-globals.ts`). A program's own writes of such a key land in the table.
 *
 * A value may be the global object when its type, or the type of the value
 * under its erasures (`globalThis as any`), has the global object's own member
 * for the key: the checker gives `typeof globalThis` each global var's own
 * symbol, so an alias typed `typeof globalThis` or `Window & typeof globalThis`
 * names the same binding (the `absent-globals.ts` property-access rule). A
 * key that is not a string constant, and a query for the whole key set
 * (`key === null`), may name any of them.
 */
export const globalObjectKeyQueryRefusalOf = (
  context: Pick<ProducerContext, 'checker' | 'absentGlobals'>,
  object: ts.Expression,
  key: string | null
): string | null => {
  const { checker } = context
  // TypeScript's declarationless intrinsic, asked from the global scope so no
  // program binding can stand in for it (`unresolvable-names.ts`).
  const intrinsic = checker.resolveName('globalThis', undefined, ts.SymbolFlags.Value, false)
  if (!intrinsic || (intrinsic.declarations?.length ?? 0) > 0) return null
  // The global object's own members. `getPropertyOfType` would also answer the
  // Object.prototype members it adds to every object type: `toString` is
  // inherited, not a binding.
  let bindings: ReadonlyMap<string, ts.Symbol> | null = null
  const isGlobalBinding = (type: ts.Type, name: string): boolean => {
    const member = checker.getPropertyOfType(type, name)
    if (!member) return false
    bindings ??= new Map(checker.getPropertiesOfType(checker.getTypeOfSymbolAtLocation(intrinsic, object)).map((own) => [own.name, own]))
    const global = bindings.get(name)
    if (!global || context.absentGlobals.isAbsentSymbol(global)) return false
    return member === global || (member.declarations ?? []).some((declaration) => global.declarations?.includes(declaration))
  }
  const exposesBinding = (type: ts.Type): boolean => {
    if (type.isUnion()) return type.types.some(exposesBinding)
    return key !== null
      ? isGlobalBinding(type, key)
      : checker.getPropertiesOfType(type).some((member) => isGlobalBinding(type, member.name))
  }
  const types = [checker.getTypeAtLocation(object), checker.getTypeAtLocation(unwrapErasedExpression(object))]
  if (!types.some(exposesBinding)) return null
  return (
    'a presence or own-key query on the global object cannot see the global bindings that live outside its run-time property table ' +
    `(${key === null ? 'the key is not a string constant, or the query asks for every key' : `\`${key}\` is one`}), so its answer would be absent where the binding exists`
  )
}
