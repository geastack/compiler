import ts from 'typescript'
import { implementationSignatureOf } from './structural-declarations.js'

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
 * interface it satisfies. node-compat's `URLSearchParams`
 * (`runtime/node/globals.ts`) spells it `IterableIterator<string>` over
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
 * arbitrary call there recursively instantiating hono's conditional route types
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
