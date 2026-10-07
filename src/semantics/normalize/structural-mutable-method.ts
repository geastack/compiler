import ts from 'typescript'
import type { StructuralTypeId } from '../../identity/ids.js'
import type { StructuralTypeTable } from '../model/structural-type-table.js'
import type { SignatureShape } from '../model/structural-types.js'
import type { ValueFlowIndex } from './flow/model.js'
import { selfBoundSlotOf } from './flow/self-bound-slot.js'
import { structuralCallSignatures } from './structural-callable.js'

/** A mutable method is a storage cell, not its initial function body. Its
 * public frame must transport the arguments consumed by every published
 * replacement. Shorter implementations ignore the unused suffix through the
 * ordinary certified callable adapter. The inventory is the shared flow
 * index; neither member reads nor invocation producers rescan assignments.
 *
 * The storage always takes the method's receiver: the class's native
 * prototype object holds the original, unbound method in the same slot
 * (`targets/cpp/class-properties/native-prototype.ts`), and that method uses
 * the receiver its caller passes.
 *
 * A slot proven to hold, on every constructed instance, only the method bound
 * to that instance (see `selfBoundSlotOf`) refines its READS instead. A bound
 * function ignores the `this` it is called with (ECMA-262 10.4.1.1), so a read
 * through `this` in an instance member of the family publishes a view of the
 * stored value that takes no receiver: the read binds its own receiver into
 * the view, and a caller such as an event dispatcher that calls
 * `listener.call(target, event)` passes none. The reads that build the bind,
 * stores, and reads through any other receiver keep the method's convention.
 * The one object of the family that is no constructed instance -- a prototype
 * object reflection handed out -- is refused at the read by the emitter
 * (`GetOperation.selfBoundView`).
 */
/** `this` of a non-static class member: an instance of that class family, or a prototype object reflection handed out. */
const isOwnInstanceThis = (flow: ValueFlowIndex, expression: ts.Expression): boolean => {
  let receiver = expression
  while (ts.isParenthesizedExpression(receiver)) receiver = receiver.expression
  if (receiver.kind !== ts.SyntaxKind.ThisKeyword) return false
  const container = flow.receiverOwnerOf(receiver)
  return (
    container !== null &&
    (ts.isMethodDeclaration(container) || ts.isConstructorDeclaration(container) || ts.isAccessor(container)) &&
    ts.isClassLike(container.parent) &&
    !(ts.getCombinedModifierFlags(container) & ts.ModifierFlags.Static)
  )
}

/** The access is the target of an assignment: a store, not a read of the slot's value. */
const isAssignmentTarget = (node: ts.PropertyAccessExpression): boolean => {
  let current: ts.Node = node
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent
  const parent = current.parent
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === current &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
}

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
  readonly selfBoundViewAt: (node: ts.Node) => boolean
} => {
  const cache = new Map<ts.Symbol, StructuralTypeId | null>()
  const pending = new Set<ts.Symbol>()
  /** Per proven self-bound slot: the reads that build a bind, and the receiverless view of the storage. */
  const selfBound = new Map<ts.Symbol, { readonly bindSources: ReadonlySet<ts.Expression>; readonly view: StructuralTypeId }>()
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
      const storage: SignatureShape = {
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
      const result = table.intern({ kind: 'signature', construct: [], call: [storage] })
      cache.set(symbol, result)
      const slot = selfBoundSlotOf(checker, flow, body, replacements)
      if (slot !== null) {
        const { implicitReceiver: _receiver, ...frame } = storage
        const view = table.intern({ kind: 'signature', construct: [], call: [{ ...frame, thisParameter: null }] })
        selfBound.set(symbol, { bindSources: slot.bindSources, view })
      }
      return result
    } finally {
      pending.delete(symbol)
    }
  }
  const symbolAt = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression, key: string | null): ts.Symbol | undefined =>
    // A JS parameter can be checker-any while the settled parameter census
    // proves its class. Ask that same receiver authority for the member;
    // otherwise a call inside a helper silently rediscovers the old body ABI.
    checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node) ??
    (key === null ? undefined : checker.getPropertyOfType(checker.getApparentType(receiverTypeAt(node.expression)), key))
  /** The self-bound slot a read observes only as its bound value, or `null` for every other read. */
  const selfBoundViewOf = (node: ts.Node): { readonly view: StructuralTypeId } | null => {
    if (!flow || !ts.isPropertyAccessExpression(node) || isAssignmentTarget(node)) return null
    const symbol = symbolAt(node, node.name.text)
    if (!symbol || resolve(symbol) === null) return null
    const slot = selfBound.get(symbol)
    if (slot === undefined || slot.bindSources.has(node) || !isOwnInstanceThis(flow, node.expression)) return null
    return slot
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
      const symbol = symbolAt(node, key)
      if (!symbol) return null
      const storage = resolve(symbol)
      if (storage === null) return null
      return selfBoundViewOf(node)?.view ?? storage
    },
    selfBoundViewAt: (node) => selfBoundViewOf(node) !== null
  }
}
