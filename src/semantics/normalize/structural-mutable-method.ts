import ts from 'typescript'
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
    const replacements = [...writes].filter((write) => write.slot === 'whole' || write.slot === 'member')
    if (!replacements.some((write) => write.value !== null)) return null
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
      const widest = signatures.reduce((held, next) => (next.parameters.length > held.parameters.length ? next : held))
      // Rest tails have independent positional semantics; never manufacture a
      // fixed frame by truncating one. Equal frames need no new authority.
      if (signatures.some((signature) => signature.parameters.some((parameter) => parameter.rest))) return null
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
