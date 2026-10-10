import ts from 'typescript'
import { implementationSignatureOf } from './structural-declarations.js'
import { inheritedImplementationOf } from './merged-declaration.js'

/**
 * What a call to an OVERLOAD SET whose one implementation is a GENERATOR
 * physically produces.
 *
 * `implementationSignatureOf` (`structural-declarations.ts`) already states the
 * rule for the callee: an overload set declares several ways to CALL a name and
 * exactly one body, so the one signature that physically exists is the
 * implementation's, and `valueTypeAt` publishes the function object from it.
 * The CALL's result was left out of that, and for a generator the two answers
 * are not interchangeable: a generator's body returns the generator object
 * `EvaluateGeneratorBody` creates, which this compiler carries as `iterator`,
 * while the overload signature above it is free to spell that object as any
 * interface it satisfies. A host's `URLSearchParams` (declared in its
 * global script) spells it `IterableIterator<string>` over
 * `*entries(): Generator<string>`, and an interface is a `native-record-ref` --
 * so the call site asked for a record result from a callee whose convention
 * returns an iterator, and cpp refused the conversion.
 *
 * BOTH halves of an invocation read this, which is why it lives in a module of
 * its own rather than beside either: `structural.ts`'s `typeAt` publishes the
 * call expression's own result through it, and `producers/invocations.ts`'s
 * `buildSelectedSignature` publishes the selected signature's return type
 * through it. Those two are compared by `validateInvocationResult`, which fails
 * the producer closed on any disagreement it has no declared divergence for --
 * correctly, because a producer that answers a question twice has published two
 * answers for one operation. There is no divergence to declare here and there
 * should not be one: this is not a case where the checker and this compiler
 * know different things, it is one physical return type that both sides must
 * read from the same place.
 *
 * Narrow on purpose, to the one disagreement a body can have with its own
 * overloads that the overloads cannot express. The ordinary overload idiom --
 * `f(x: string): string; f(x: number): number; f(x: any): any {...}` -- is the
 * exact opposite case: there the implementation's `any` is the widened frame
 * the several signatures share, and preferring it would box every call result
 * in the program. A generator body states no such widening; `asteriskToken` is
 * the whole gate.
 *
 * A generic implementation is refused rather than guessed at: its own return
 * type still names its signature's type parameters, and this has no call-site
 * instantiation to bind them with, so answering would trade a wrong carrier for
 * an unresolved one. A call anywhere in an OPTIONAL CHAIN is refused for the
 * mirror reason `presentReturnTypeOf` exists: `a?.b()` really is `T |
 * undefined`, and that `undefined` is a fact about the call expression rather
 * than about the callee, so replacing the whole expression's type with the
 * callee's return would strip the absent branch the guard was written for.
 * `ts.isOptionalChain` rather than the call's own `questionDotToken`, because
 * `a?.b()` carries the `?.` on the property access and every later link of the
 * chain publishes the same short circuit.
 *
 * Asked of the callee's SYMBOL rather than of `getResolvedSignature`, which is
 * the answer this wants and the one thing that must not be asked from inside
 * `typeAt`: `structural-callable.ts`'s own comment records resolving every
 * arbitrary call there recursively instantiating a library's conditional types
 * until the host stack overflowed. Nothing is lost by not asking -- TypeScript
 * never resolves a call to the implementation signature while overloads exist,
 * so a symbol carrying both shapes resolves to a bodiless overload at every call
 * site by construction.
 */
export const physicalGeneratorOverloadResultAt = (checker: ts.TypeChecker, node: ts.Node): ts.Type | null => {
  if (!ts.isCallExpression(node) || ts.isOptionalChain(node)) return null
  const callee = node.expression
  if (!ts.isIdentifier(callee) && !ts.isPropertyAccessExpression(callee)) return null
  const symbol = checker.getSymbolAtLocation(ts.isIdentifier(callee) ? callee : callee.name)
  return physicalGeneratorOverloadReturnOf(checker, symbol?.getDeclarations() ?? [])
}

/**
 * The same answer for a MEMBER SYMBOL rather than a call site.
 *
 * `producers/iteration-yield.ts`'s `iteratorRecordTypesOf` reads what a
 * resolved `[Symbol.iterator]` returns straight off the member symbol's own
 * callable type, and TypeScript shows an overload set's bodiless signatures
 * there and never its implementation -- so `*[Symbol.iterator](): Generator<T>`
 * behind an `[Symbol.iterator](): IterableIterator<T>` overload read back as
 * the interface. `producers/protocol.ts`'s `generatorRecordTypeOf` then failed
 * its `isGeneratorType` test and published the synthetic ECMA-262 `{ next() }`
 * record for a method whose body hands back a native cursor, which is the
 * `method "..." body convention cannot fill its published bound-method
 * convention` refusal (`emit-class-properties.ts`) -- the same one fact
 * disagreeing with itself, one authority over from the call result above.
 */
export const physicalGeneratorOverloadReturnOf = (checker: ts.TypeChecker, declarations: readonly ts.Declaration[]): ts.Type | null => {
  const generator = declarations.find(
    (declaration): declaration is ts.MethodDeclaration | ts.FunctionDeclaration =>
      (ts.isMethodDeclaration(declaration) || ts.isFunctionDeclaration(declaration)) &&
      declaration.asteriskToken !== undefined &&
      declaration.body !== undefined
  )
  if (!generator) return null
  // `implementationSignatureOf` is what makes this an OVERLOAD set rather than
  // a lone generator: it answers only when some declaration of the same symbol
  // is bodiless, and a lone generator's call result already is its own.
  const implementation = implementationSignatureOf(checker, generator)
  if (!implementation || (implementation.getTypeParameters()?.length ?? 0) > 0) return null
  return checker.getReturnTypeOfSignature(implementation)
}

/**
 * What a call through a member only a merged interface RE-DECLARES produces,
 * where that interface's typing view names a UNION OF CALLABLES at a position
 * the body's own result holds ONE callable.
 *
 * `inheritedImplementationOf` (`merged-declaration.ts`) already states the
 * rule for the callee: the interface member has no body, so the call runs the
 * base class's and passes its arguments in that body's frame. The RESULT kept
 * the typing view, and for one shape the view cannot be given to the value at
 * all. A `TypedEventEmitter<Events>` declares
 * `listeners<K extends keyof Events>(event: K | ...): Events[K][]`, and a
 * caller asks it with `K` the union of every event name, so the view
 * is an array of a many-arm union of listener signatures -- while the body
 * (an event emitter's `listeners`) hands back its stored `Listener[]`.
 * A union of callables has no runtime discriminator: every arm is `typeof
 * 'function'`, and TypeScript itself never narrows one function type out of
 * another. So no conversion can place a stored listener into the arm it
 * belongs to; picking one would adapt it through a parameter type it never
 * declared (an event object checked as another event's class), and the
 * listener handed back into `on` would no longer be the function the program
 * registered. The value is the stored callable, so its type is the body's.
 *
 * Narrow on purpose, to that one unrealizable view. A view that names a
 * SINGLE callable (`listeners('close')`) is a real conversion of the stored
 * value and keeps the view; so does any result that is not a callable union
 * over a single stored callable. A generic body is refused for the reason
 * `physicalGeneratorOverloadReturnOf` gives.
 */
export const physicalInheritedCallableResultAt = (checker: ts.TypeChecker, node: ts.Node): ts.Type | null => {
  const physical = physicalInheritedCallableReturnAt(checker, node)
  if (physical === null || !ts.isOptionalChain(node)) return physical
  // The chain's `undefined` is a fact about the EXPRESSION, the reason an
  // optional chain was refused here before: `this.s.srvPoller?.listeners(e)`
  // is the body's result where the guard held and `undefined` where it did
  // not, so the expression keeps that arm and only the present branch is the
  // body's. `getUnionType` is not on the checker's public surface; without it
  // the chain stays on the checker's view.
  const constructing = checker as unknown as { getUnionType?: (types: readonly ts.Type[]) => ts.Type }
  return typeof constructing.getUnionType === 'function' ? constructing.getUnionType([physical, checker.getUndefinedType()]) : null
}

/**
 * The body's own result for such a call, WITHOUT an optional chain's
 * `undefined`: what the `[[Call]]` inside `a?.b()` returns on the branch
 * where it runs, and so what its selected signature returns.
 */
export const physicalInheritedCallableReturnAt = (checker: ts.TypeChecker, node: ts.Node): ts.Type | null => {
  if (!ts.isCallExpression(node)) return null
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee)) return null
  const member = checker.getSymbolAtLocation(callee.name)
  const implementation = member ? inheritedImplementationOf(checker, member) : null
  const body = implementation?.declarations?.find(
    (declaration): declaration is ts.MethodDeclaration => ts.isMethodDeclaration(declaration) && declaration.body !== undefined
  )
  if (!body) return null
  const frame = implementationSignatureOf(checker, body) ?? checker.getSignatureFromDeclaration(body) ?? null
  if (!frame || (frame.getTypeParameters()?.length ?? 0) > 0) return null
  const physical = checker.getReturnTypeOfSignature(frame)
  const expression = checker.getTypeAtLocation(node)
  const view = ts.isOptionalChain(node) ? checker.getNonNullableType(expression) : expression
  return viewNamesUnplaceableCallableUnion(checker, view, physical) ? physical : null
}

/** Whether `view` holds a union of two or more callables where `physical` holds one callable, through array elements. */
const viewNamesUnplaceableCallableUnion = (checker: ts.TypeChecker, view: ts.Type, physical: ts.Type): boolean => {
  if (checker.isArrayType(view) && checker.isArrayType(physical)) {
    const [viewElement] = checker.getTypeArguments(view as ts.TypeReference)
    const [physicalElement] = checker.getTypeArguments(physical as ts.TypeReference)
    return (
      viewElement !== undefined && physicalElement !== undefined && viewNamesUnplaceableCallableUnion(checker, viewElement, physicalElement)
    )
  }
  const isCallable = (type: ts.Type): boolean => type.getCallSignatures().length > 0 && type.getConstructSignatures().length === 0
  if (physical.isUnion() || !isCallable(physical)) return false
  if (view.isUnion()) return view.types.length > 1 && view.types.every(isCallable)
  return isCallable(view) && viewCannotSupplyStoredReceiver(checker, view, physical)
}

/**
 * A SINGLE callable view the stored callable still cannot be converted into:
 * the stored body declares the receiver it runs on (an emitter's `Listener`
 * is `(this: EventEmitter, ...args) => unknown`, because `emit` applies each
 * listener to its emitter), and no signature of the view declares a receiver
 * that is one. Event maps written as method shorthands
 * (`{ close(): void }`), whose receiver is the map record, never an emitter.
 * An adapter from the stored listener into such a view would have to invent
 * the emitter it calls it on -- there is none to hand -- so this view is as
 * unrealizable as the union above, and the value keeps the body's type.
 */
const viewCannotSupplyStoredReceiver = (checker: ts.TypeChecker, view: ts.Type, physical: ts.Type): boolean => {
  const [stored, ...others] = physical.getCallSignatures()
  const storedThis = stored?.thisParameter
  if (!stored || others.length > 0 || !storedThis?.valueDeclaration) return false
  const required = checker.getTypeOfSymbolAtLocation(storedThis, storedThis.valueDeclaration)
  return view.getCallSignatures().every((signature) => {
    const own = signature.thisParameter
    return !own?.valueDeclaration || !checker.isTypeAssignableTo(checker.getTypeOfSymbolAtLocation(own, own.valueDeclaration), required)
  })
}

/**
 * The binding that receives such a result, and every read of it: an
 * unannotated `const x = <call>`, or the head of `for (const x of <call>)`,
 * which then holds one of the stored callables. Without this the value is the
 * body's while the cell it is stored into is still laid out from the view's
 * union, and the store is the very placement the result rule refuses to
 * invent. An annotated binding keeps its annotation: the program said what
 * it wants the value converted into.
 */
export const physicalInheritedCallableBindingAt = (checker: ts.TypeChecker, node: ts.Node): ts.Type | null => {
  const declaration = ts.isVariableDeclaration(node) ? node : ts.isIdentifier(node) ? soleVariableDeclarationOf(checker, node) : null
  if (!declaration || declaration.type || !ts.isIdentifier(declaration.name)) return null
  const list = declaration.parent
  const loop = ts.isVariableDeclarationList(list) ? list.parent : undefined
  if (loop && ts.isForOfStatement(loop) && loop.initializer === list) {
    if (loop.awaitModifier) return null
    const iterated = physicalInheritedCallableResultAt(checker, skipParentheses(loop.expression))
    const [element] = iterated && checker.isArrayType(iterated) ? checker.getTypeArguments(iterated as ts.TypeReference) : []
    return element ?? null
  }
  return declaration.initializer ? physicalInheritedCallableResultAt(checker, skipParentheses(declaration.initializer)) : null
}

const soleVariableDeclarationOf = (checker: ts.TypeChecker, node: ts.Identifier): ts.VariableDeclaration | null => {
  const declarations = checker.getSymbolAtLocation(node)?.declarations
  const only = declarations?.length === 1 ? declarations[0] : undefined
  return only && ts.isVariableDeclaration(only) ? only : null
}

const skipParentheses = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ? skipParentheses(node.expression) : node
