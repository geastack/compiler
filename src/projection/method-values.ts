import type { DeclarationId, FunctionId } from '../identity/ids.js'
import type { ClassLayout, ClassMethod } from './classes.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import { abiOfCallee } from './callee.js'
import { methodCopyHeldBy } from './dispatch.js'

/** A published callable frame selects among the owning class's same-key copies. */
export const heldMethodCopyOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  abiOf: (callable: FunctionId) => CallableAbi | null,
  method: ClassMethod,
  key: string,
  held: CallableAbi
): ClassMethod => {
  for (const layout of classes.values()) {
    if (!layout.methods.includes(method)) continue
    const copies = layout.methods.filter((candidate) => candidate.key === key)
    return copies.length < 2 ? method : (methodCopyHeldBy(copies, held, abiOf) ?? method)
  }
  return method
}

/** Sum-valued reads select a copy only when every published frame agrees. */
export const publishedMethodCopyOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  abiOf: (callable: FunctionId) => CallableAbi | null,
  method: ClassMethod,
  key: string,
  published: Representation
): ClassMethod => {
  const held = (published.kind === 'tagged-union' ? published.arms.map((arm) => arm.value) : [published]).flatMap((carrier) => {
    const abi = abiOfCallee(carrier)
    return abi === null ? [] : [abi]
  })
  for (const layout of classes.values()) {
    if (!layout.methods.some((entry) => entry.key === key && entry.callable === method.callable)) continue
    const copies = layout.methods.filter((candidate) => candidate.key === key)
    if (copies.length < 2) return method
    const chosen = new Set(held.flatMap((abi) => methodCopyHeldBy(copies, abi, abiOf) ?? []))
    return chosen.size === 1 ? [...chosen][0]! : method
  }
  return method
}
