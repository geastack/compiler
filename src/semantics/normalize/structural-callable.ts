import ts from 'typescript'
import type { StructuralTypeId } from '../../identity/ids.js'
import type { StructuralTypeTable } from '../model/structural-type-table.js'
import type { SignatureShape } from '../model/structural-types.js'
import type { ValueFlowIndex } from './flow/model.js'
import { sourceValueSessionOf } from './flow/source-value-session.js'
import type { SourceCallableObject } from './flow/source-callable-own-data.js'

/** @semanticCategory generic-primitive */
export interface StructuralOwnCallableInvocation {
  readonly body: SourceCallableObject
  readonly signature: ts.Signature
  readonly type: StructuralTypeId
  readonly frame: SignatureShape
  readonly observedResult: StructuralTypeId
}

/** The installed source, rather than an inherited library member or an
 * asserted alias, owns every slot of this executable frame.
 */
export const createStructuralOwnCallableInvocationResolver = (
  checker: ts.TypeChecker,
  table: StructuralTypeTable,
  flow: ValueFlowIndex | undefined,
  project: (signature: ts.Signature) => SignatureShape,
  admittedSourceOf?: (call: ts.CallExpression) => SourceCallableObject | null
): ((node: ts.Node) => StructuralOwnCallableInvocation | null) => {
  const pending = new Set<ts.Node>()
  return (node) => {
    if (!flow || !ts.isCallExpression(node) || node.questionDotToken || node.typeArguments?.length || pending.has(node)) return null
    pending.add(node)
    try {
      const body = admittedSourceOf ? admittedSourceOf(node) : sourceValueSessionOf(checker, flow).ordinaryOwnCallableSourceOf(node)
      if (!body || body.typeParameters?.length) return null
      const signature = checker.getSignatureFromDeclaration(body)
      if (!signature) return null
      const frame = project(signature)
      const result = table.get(frame.result).shape
      const observedResult =
        result.kind === 'primitive' && result.primitive === 'void'
          ? table.intern({ kind: 'primitive', primitive: 'undefined' })
          : frame.result
      return { body, signature, frame, observedResult, type: table.intern({ kind: 'signature', call: [frame], construct: [] }) }
    } finally {
      pending.delete(node)
    }
  }
}

/** TypeScript's unchecked-call placeholder has no physical declaration. */
export const isFabricatedSignatureShape = (checker: ts.TypeChecker, signature: ts.Signature): boolean =>
  signature.declaration === undefined &&
  signature.getParameters().length === 0 &&
  (checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.Any) !== 0

/** Every alternative must actually declare one callable frame. */
export const structuralCallSignatures = (
  table: StructuralTypeTable,
  id: StructuralTypeId,
  seen: ReadonlySet<StructuralTypeId> = new Set()
): readonly SignatureShape[] | null => {
  if (seen.has(id)) return null
  const next = new Set(seen).add(id)
  const shape = table.get(id).shape
  if (shape.kind === 'declared') return shape.body ? structuralCallSignatures(table, shape.body, next) : null
  if (shape.kind === 'signature') return shape.call.length === 1 && shape.construct.length === 0 ? shape.call : null
  if (shape.kind !== 'union') return null
  const arms = shape.members.map((member) => structuralCallSignatures(table, member, next))
  return arms.length && arms.every((arm) => arm !== null) ? arms.flatMap((arm) => arm ?? []) : null
}

/** A native constructor choice returns every arm's instance, even when the checker merges their identical shapes. */
export const createStructuralConstructResultResolver = (
  table: StructuralTypeTable,
  read: (node: ts.Node) => StructuralTypeId
): ((node: ts.Node) => StructuralTypeId | null) => {
  const pending = new Set<ts.Node>()
  return (node) => {
    if (!ts.isNewExpression(node) || pending.has(node)) return null
    pending.add(node)
    try {
      const callee = table.get(read(node.expression)).shape
      if (callee.kind !== 'union' || callee.members.length < 2) return null
      const results: StructuralTypeId[] = []
      for (const member of callee.members) {
        if (table.isOpen(member)) return null
        const arm = table.get(member).shape
        if (arm.kind !== 'class-constructor' || arm.construct === null || table.isOpen(arm.construct)) return null
        const frame = table.get(arm.construct).shape
        if (frame.kind !== 'signature' || frame.construct.length !== 1) return null
        const signature = frame.construct[0]
        if (!signature) return null
        results.push(signature.result)
      }
      return table.intern({ kind: 'union', members: results })
    } finally {
      pending.delete(node)
    }
  }
}

/** An unchecked call through known native alternatives returns their results. */
export const createStructuralCallResultResolver = (
  _checker: ts.TypeChecker,
  table: StructuralTypeTable,
  read: (node: ts.Node) => StructuralTypeId,
  ownInvocationAt?: (node: ts.Node) => StructuralOwnCallableInvocation | null
): ((node: ts.Node) => StructuralTypeId | null) => {
  const pending = new Set<ts.Node>()
  return (node) => {
    if (!ts.isCallExpression(node) || node.questionDotToken || pending.has(node)) return null
    const own = ownInvocationAt?.(node)
    if (own) return own.observedResult
    // Function.prototype.call/apply is generic in the library and loses the
    // return when its receiver is a union with no joined signature. Read the
    // authenticated callable receiver directly. Asking the checker to resolve
    // every arbitrary call here recursively instantiated a library's conditional
    // types until the host stack overflowed.
    if (!ts.isPropertyAccessExpression(node.expression)) return null
    if (node.expression.name.text !== 'call' && node.expression.name.text !== 'apply') return null
    pending.add(node)
    const calls = structuralCallSignatures(table, read(node.expression.expression))
    pending.delete(node)
    if (!calls) return null
    const members = calls.map((call) => {
      const result = table.get(call.result).shape
      return result.kind === 'primitive' && result.primitive === 'void'
        ? table.intern({ kind: 'primitive', primitive: 'undefined' })
        : call.result
    })
    return members.length === 1 ? (members[0] ?? null) : table.intern({ kind: 'union', members })
  }
}
