import ts from 'typescript'
import type { UnresolvableNameCensus } from './unresolvable-names.js'
import { unwrapErasedExpression } from './producers/erasure.js'

/**
 * Whether `declaration` is a `var` or function declaration at the top level
 * of a SCRIPT: the declarations ECMA-262 9.1.1.4.17/18 (CreateGlobalVarBinding,
 * CreateGlobalFunctionBinding) install as own data properties of the global
 * object. A `let`/`const`/`class` at the same level lives in the global
 * declarative record and is NOT a property of the object; a module's
 * top-level declarations are the module's own; an ambient declaration
 * (`declare var`, in a `.d.ts` or not) creates no binding at all -- it is a
 * host's claim, which `hostGlobalMemberDeclarationOf` judges by its own rule.
 */
export const isScriptGlobalObjectPropertyDeclaration = (declaration: ts.Declaration): boolean => {
  const file = declaration.getSourceFile()
  if (file.isDeclarationFile || ts.isExternalModule(file)) return false
  if ((ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) !== 0) return false
  if (ts.isFunctionDeclaration(declaration)) return declaration.parent === file
  if (!ts.isVariableDeclaration(declaration)) return false
  const list = declaration.parent
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.BlockScoped) !== 0) return false
  return ts.isVariableStatement(list.parent) && list.parent.parent === file
}

export interface ScriptGlobalRedefinition {
  /** The script-level `var` whose global-object property is redefined. */
  readonly declaration: ts.VariableDeclaration
  readonly symbol: ts.Symbol
  /** The descriptor's `value`, which becomes the var's value. */
  readonly value: ts.Expression
}

/**
 * `Object.defineProperty(globalThis, 'K', { value: V })` where `K` is the
 * program's own script-level `var`, read as the plain store `K = V` it is.
 *
 * `@hono/node-server` swaps the platform's `Request` and `Response` this way.
 * A script `var` is an own data property of the global object that is
 * writable, enumerable and NOT configurable (9.1.1.4.17). For a descriptor
 * naming only `value`, ValidateAndApplyPropertyDescriptor (10.1.6.3) keeps
 * every attribute and replaces the value, and a writable property admits
 * that. So the call writes the var's cell and nothing else, and the call
 * returns the global object, which is why only a call whose result is
 * discarded is claimed.
 *
 * Any other descriptor is not this store: `writable: false` changes an
 * attribute, `configurable: true`, `enumerable: false` or an accessor throws
 * against the non-configurable property, and a spread or computed member
 * states keys nobody can read here. Those stay with the mutation census.
 *
 * The caller authenticates `Object.defineProperty` itself, each with its own
 * authority. The census and the invocation producer both ask this, so the
 * write the producer lowers is exactly the write the census stops tainting
 * the var for.
 */
export const scriptGlobalValueRedefinitionOf = (
  checker: ts.TypeChecker,
  names: Pick<UnresolvableNameCensus, 'isIntrinsicGlobalThis'>,
  call: ts.CallExpression
): ScriptGlobalRedefinition | null => {
  if (!ts.isExpressionStatement(call.parent) || call.arguments.length !== 3) return null
  const [target, key, descriptor] = call.arguments as unknown as readonly [ts.Expression, ts.Expression, ts.Expression]
  const holder = unwrapErasedExpression(target)
  if (!ts.isIdentifier(holder) || !names.isIntrinsicGlobalThis(holder)) return null
  if (!ts.isStringLiteralLike(key) || !ts.isObjectLiteralExpression(descriptor) || descriptor.properties.length !== 1) return null
  const [property] = descriptor.properties
  if (!property || !ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== 'value') return null
  const symbol = checker.getPropertyOfType(checker.getTypeAtLocation(holder), key.text)
  const declaration = symbol?.valueDeclaration
  if (!symbol || !declaration || !ts.isVariableDeclaration(declaration) || !isScriptGlobalObjectPropertyDeclaration(declaration))
    return null
  // A second VALUE declaration of the same name (another script's `var`, or a
  // host's) would make the property's one cell ambiguous. A merged `interface`
  // of the same name (`interface Request` beside `var Request`) declares no
  // value and does not.
  const values = (symbol.declarations ?? []).filter(
    (candidate) => ts.isVariableDeclaration(candidate) || ts.isFunctionDeclaration(candidate) || ts.isClassLike(candidate)
  )
  if (values.length !== 1) return null
  return { declaration, symbol, value: property.initializer }
}
