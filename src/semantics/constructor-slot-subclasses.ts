import ts from 'typescript'
import type { DeclarationId } from '../identity/ids.js'
import type { IdentityTable } from './normalize/identities.js'

/**
 * Which DERIVED class constructors the program stores into a slot typed as a
 * base class's constructor, keyed by the base.
 *
 * `typeof Base` is the checker's type for the `Base` identifier AND for any
 * cell declared with it, and `representation/derive.ts` gives it a
 * constructor family whose one member is `Base`. That member list is a
 * promise every consumer cashes: construction inlines `Base`'s initializer
 * (`ir/native-class-construction.ts`), static reads resolve to `Base`'s
 * members. `var Request: typeof RequestImpl = RequestImpl`, later replaced by
 * `@hono/node-server`'s own subclass, breaks the promise -- `new Request()`
 * must build the subclass -- so the family has to name every class the
 * program can put there, and that is a fact about the program's WRITES, which
 * only this layer can see.
 *
 * A write is: a value position whose contextual type is `typeof Base`
 * (an assignment, an annotated initializer, an argument, a return, an object
 * literal property), plus `Object.defineProperty(G, 'K', { value: V })`,
 * whose descriptor's `value` is `any` to the checker but lands in `G.K`, typed
 * by `G`'s own declaration. Only a PROPER subclass is recorded: an unrelated
 * class of the same shape has no base subobject to upcast through, so its
 * store stays refused by the conversion census rather than being admitted
 * here.
 */
export const constructorSlotSubclassesOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[],
  heritage: ReadonlyMap<DeclarationId, readonly DeclarationId[]>
): ReadonlyMap<DeclarationId, readonly DeclarationId[]> => {
  const subclasses = new Map<DeclarationId, DeclarationId[]>()

  // The static side of a class only: `typeof C` is the type of the class
  // symbol's value, while the instance type shares the symbol.
  const classOfConstructorType = (type: ts.Type): DeclarationId | null => {
    const symbol = type.getSymbol()
    if (!symbol || (symbol.flags & ts.SymbolFlags.Class) === 0) return null
    const node = symbol.declarations?.find((candidate) => ts.isClassLike(candidate))
    if (!node || checker.getTypeOfSymbol(symbol) !== type) return null
    return identities.declarationIdOf(node)
  }

  const record = (target: ts.Type | undefined, source: ts.Expression): void => {
    if (!target) return
    const derived = classOfConstructorType(checker.getTypeAtLocation(source))
    if (derived === null) return
    const ancestors = heritage.get(derived) ?? []
    for (const arm of target.isUnion() ? target.types : [target]) {
      const base = classOfConstructorType(arm)
      if (base === null || base === derived || !ancestors.includes(base)) continue
      const known: DeclarationId[] = subclasses.get(base) ?? []
      if (!known.includes(derived)) known.push(derived)
      subclasses.set(base, known)
    }
  }

  const isObjectDefineProperty = (call: ts.CallExpression): boolean => {
    const callee = call.expression
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'defineProperty' &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'Object'
    )
  }

  const recordDefinedValue = (call: ts.CallExpression): void => {
    const [holder, key, descriptor] = call.arguments
    if (!holder || !key || !descriptor || !ts.isStringLiteralLike(key) || !ts.isObjectLiteralExpression(descriptor)) return
    const value = descriptor.properties.find(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'value'
    )
    if (!value) return
    const slot = checker.getPropertyOfType(checker.getTypeAtLocation(holder), key.text)
    if (slot) record(checker.getTypeOfSymbolAtLocation(slot, call), value.initializer)
  }

  // The source is looked at only where a constructor can plausibly be named;
  // asking the checker for every expression's type would cost the whole walk.
  const isNamedValue = (node: ts.Expression): boolean => {
    let inner = node
    while (ts.isParenthesizedExpression(inner)) inner = inner.expression
    return ts.isIdentifier(inner) || ts.isPropertyAccessExpression(inner) || ts.isClassExpression(inner)
  }

  const valuePosition = (node: ts.Node): ts.Expression | null => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return node.right
    if (ts.isVariableDeclaration(node) && node.type && node.initializer) return node.initializer
    if (ts.isPropertyDeclaration(node) && node.type && node.initializer) return node.initializer
    if (ts.isReturnStatement(node) && node.expression) return node.expression
    if (ts.isPropertyAssignment(node)) return node.initializer
    return null
  }

  for (const file of files) {
    const visit = (node: ts.Node): void => {
      const value = valuePosition(node)
      if (value && isNamedValue(value)) record(checker.getContextualType(value), value)
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        for (const argument of node.arguments ?? []) if (isNamedValue(argument)) record(checker.getContextualType(argument), argument)
        if (ts.isCallExpression(node) && isObjectDefineProperty(node)) recordDefinedValue(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }

  return subclasses
}
