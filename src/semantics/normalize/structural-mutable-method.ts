import ts from '#typescript'
import type { StructuralTypeId } from '../../identity/ids.js'
import type { StructuralTypeTable } from '../model/structural-type-table.js'
import type { SignatureShape } from '../model/structural-types.js'
import type { ValueFlowIndex } from './flow/model.js'
import { structuralCallSignatures } from './structural-callable.js'

/** A mutable method is a storage cell, not its initial function body. Its
 * public frame must transport the arguments consumed by every published
 * replacement. Shorter implementations ignore the unused suffix through the
 * ordinary certified callable adapter. The inventory is the shared flow
 * index; neither member reads nor invocation producers rescan assignments.
 */
export const createMutableMethodResolver = (
  checker: ts.TypeChecker,
  table: StructuralTypeTable,
  flow: ValueFlowIndex | undefined,
  signatureOf: (signature: ts.Signature) => SignatureShape,
  read: (node: ts.Node) => StructuralTypeId,
  receiverTypeAt: (node: ts.Expression) => ts.Type
): {
  readonly storageTypeAt: (node: ts.MethodDeclaration) => StructuralTypeId | null
  readonly readTypeAt: (node: ts.Node) => StructuralTypeId | null
} => {
  const cache = new Map<ts.Symbol, StructuralTypeId | null>()
  const pending = new Set<ts.Symbol>()
  const keyOf = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null =>
    ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)
        ? node.argumentExpression.text
        : null
  const memberSymbolOf = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression, key: string): ts.Symbol | undefined =>
    checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node) ??
    checker.getPropertyOfType(checker.getApparentType(receiverTypeAt(node.expression)), key)
  // Keys some write stores through a receiver the checker cannot resolve to a
  // member (`(m as any).hook = ...`): the write lands in the method's own slot
  // at run time while naming no symbol, so `writesToSymbol` never sees it.
  let untypedWrites: ReadonlySet<string> | undefined
  const untypedWriteKeys = (): ReadonlySet<string> => {
    if (untypedWrites) return untypedWrites
    const keys = new Set<string>()
    for (const access of flow?.propertyAccesses ?? []) {
      const parent = access.parent
      if (!ts.isBinaryExpression(parent) || parent.left !== access || parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue
      const key = keyOf(access)
      if (key !== null && checker.getSymbolAtLocation(ts.isPropertyAccessExpression(access) ? access.name : access) === undefined)
        keys.add(key)
    }
    return (untypedWrites = keys)
  }
  // Every call spelled as a member call, by key, so a method's surplus
  // arguments are found without rescanning the program per method.
  let memberCalls: ReadonlyMap<string, readonly ts.CallExpression[]> | undefined
  const memberCallsOf = (key: string): readonly ts.CallExpression[] => {
    if (!memberCalls) {
      const byKey = new Map<string, ts.CallExpression[]>()
      for (const site of flow?.calls ?? []) {
        const call = site.call
        if (!ts.isCallExpression(call)) continue
        const callee = call.expression
        if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) continue
        const name = keyOf(callee)
        if (name === null) continue
        const list = byKey.get(name) ?? []
        list.push(call)
        byKey.set(name, list)
      }
      memberCalls = byKey
    }
    return memberCalls.get(key) ?? []
  }
  /** The most arguments any call of this method passes, or null when one spreads them. */
  const suppliedArity = (symbol: ts.Symbol): number | null => {
    let widest = 0
    for (const call of memberCallsOf(symbol.name)) {
      const callee = call.expression as ts.PropertyAccessExpression | ts.ElementAccessExpression
      // A property read can resolve to a transient (instantiated) symbol of the same declaration.
      const resolved = memberSymbolOf(callee, symbol.name)
      if (resolved !== symbol && !resolved?.declarations?.some((declaration) => symbol.declarations?.includes(declaration))) continue
      if (call.arguments.some(ts.isSpreadElement)) return null
      widest = Math.max(widest, call.arguments.length)
    }
    return widest
  }
  const resolve = (symbol: ts.Symbol): StructuralTypeId | null => {
    if (cache.has(symbol)) return cache.get(symbol) ?? null
    if (!flow || pending.has(symbol)) return null
    const declarations = symbol.declarations ?? []
    const methods = declarations.filter(ts.isMethodDeclaration)
    const body = methods.find((method) => method.body !== undefined)
    if (!body || methods.some((method) => method.parent !== body.parent)) return null
    if (ts.getCombinedModifierFlags(body) & ts.ModifierFlags.Static) return null
    const writes = new Set([
      ...flow.writesToSymbol(symbol),
      ...declarations.flatMap((declaration) => flow.writesToDeclaration(declaration))
    ])
    // The flow index files a method's own `return`/`yield` under its
    // declaration: those write the call's RESULT, not the method's storage,
    // and counting them re-translated a generic class's open body signature
    // outside every copy.
    const replacements = [...writes].filter(
      (write) => (write.slot === 'whole' || write.slot === 'member') && write.edge !== 'return' && write.edge !== 'yield'
    )
    const replaced = replacements.some((write) => write.value !== null)
    if (!replaced && !untypedWriteKeys().has(symbol.name)) return null
    pending.add(symbol)
    try {
      const original = checker.getSignatureFromDeclaration(body)
      if (!original) return null
      const initial = signatureOf(original)
      const signatures = checker
        .getTypeOfSymbolAtLocation(symbol, body)
        .getCallSignatures()
        .map((signature) => signatureOf(signature))
      for (const write of replacements) {
        if (!write.value) continue
        const alternatives = structuralCallSignatures(table, read(write.value))
        // An unknown/noncallable replacement cannot be represented by a
        // fabricated native function frame. Leave its existing refusal intact.
        if (!alternatives) return null
        signatures.push(...alternatives)
      }
      if (!signatures.length) return null
      const longest = signatures.reduce((held, next) => (next.parameters.length > held.parameters.length ? next : held))
      // Rest tails have independent positional semantics; never manufacture a
      // fixed frame by truncating one. Equal frames need no new authority.
      if (signatures.some((signature) => signature.parameters.some((parameter) => parameter.rest))) return null
      // A call passes every argument it spells (ECMA-262 13.3.8.1), and the
      // function the slot holds by then is whichever replacement was stored,
      // which may bind more parameters than the declared body does. A frame
      // narrower than the widest call drops the surplus before the stored
      // function can bind it, so the frame carries it as an optional `any`.
      const supplied = suppliedArity(symbol)
      if (supplied === null) return null
      const anyType = table.intern({ kind: 'primitive', primitive: 'any' })
      const surplus = Array.from({ length: Math.max(0, supplied - longest.parameters.length) }, () => ({
        type: anyType,
        slot: anyType,
        optional: true,
        rest: false,
        hasInitializer: false
      }))
      if (surplus.length === 0 && !replaced) return null
      const widest = surplus.length === 0 ? longest : { ...longest, parameters: [...longest.parameters, ...surplus] }
      if (surplus.length > 0) signatures.push(widest)
      const join = (values: readonly StructuralTypeId[]): StructuralTypeId => {
        const members = [...new Set(values)]
        return members.length === 1 ? members[0]! : table.intern({ kind: 'union', members })
      }
      const result = table.intern({
        kind: 'signature',
        construct: [],
        call: [
          {
            ...widest,
            thisParameter: initial.thisParameter,
            result: join(signatures.map((signature) => signature.result)),
            parameters: widest.parameters.map((parameter, ordinal) => {
              const present = signatures.flatMap((signature) => (signature.parameters[ordinal] ? [signature.parameters[ordinal]!] : []))
              return {
                ...parameter,
                type: join(present.map((entry) => entry.type)),
                slot: join(present.map((entry) => entry.slot))
              }
            })
          }
        ]
      })
      cache.set(symbol, result)
      return result
    } finally {
      pending.delete(symbol)
    }
  }
  return {
    storageTypeAt: (node) => {
      const symbol = checker.getSymbolAtLocation(node.name)
      return symbol ? resolve(symbol) : null
    },
    readTypeAt: (node) => {
      if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return null
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)
          ? node.argumentExpression.text
          : null
      // A JS parameter can be checker-any while the settled parameter census
      // proves its class. Ask that same receiver authority for the member;
      // otherwise a call inside a helper silently rediscovers the old body ABI.
      const symbol =
        checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node) ??
        (key === null ? undefined : checker.getPropertyOfType(checker.getApparentType(receiverTypeAt(node.expression)), key))
      return symbol ? resolve(symbol) : null
    }
  }
}
