import type { DeclarationId, IrValueId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { ClassLayout } from '../projection/classes.js'
import { classMemberOf, classStaticMemberOf } from '../projection/fields.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { CallCalleeIdentity, IrBody, IrOperation } from './model.js'
import { operandsOfIrOperation, resultOfIrOperation } from './queries.js'

/**
 * Static methods have projected implementation identities just like instance
 * methods. Publish them only while the constructor object stays inside uses
 * that cannot replace its members. This is a callable identity proof, not a
 * request to bypass the callable's environment or receiver convention.
 */
export const closedStaticCallablesOf = (
  bodies: readonly IrBody[],
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  classes: ReadonlyMap<DeclarationId, ClassLayout>
): ReadonlyMap<IrValueId, CallCalleeIdentity> => {
  const operations = bodies.flatMap((body) =>
    body.blockOrder.flatMap((id) => {
      const block = body.blocks.get(id)
      return block ? [...block.operations, block.terminator] : []
    })
  )
  const producers = new Map<IrValueId, IrOperation>()
  const writes = new Map<DeclarationId, IrValueId[]>()
  for (const operation of operations) {
    const result = resultOfIrOperation(operation)
    if (result) producers.set(result.id, operation)
    if (operation.kind === 'binding-write') {
      const values = writes.get(operation.declaration) ?? []
      values.push(operation.value.value)
      writes.set(operation.declaration, values)
    }
  }
  const nativeConstructor = (id: IrValueId, declaration: DeclarationId, visiting = new Set<IrValueId>()): boolean => {
    if (visiting.has(id)) return false
    const operation = producers.get(id)
    if (!operation) return false
    if (operation.kind === 'allocate-constructor') return operation.declaration === declaration
    let sources: readonly IrValueId[] | null = null
    if (operation.kind === 'binding-read') {
      const storage = placements.get(operation.declaration)?.storage.kind
      if (storage === 'local' || storage === 'region') sources = writes.get(operation.declaration) ?? null
    } else if (operation.kind === 'phi') sources = operation.incoming.map((incoming) => incoming.value.value)
    else if (
      operation.kind === 'convert' &&
      representationKey(operation.source.representation) === representationKey(operation.result.representation)
    )
      sources = [operation.source.value]
    if (!sources?.length) return false
    visiting.add(id)
    const closed = sources.every((source) => nativeConstructor(source, declaration, visiting))
    visiting.delete(id)
    return closed
  }
  const membersOf = (value: Representation): readonly DeclarationId[] => {
    if (value.kind === 'constructor-family') return value.members
    // An escaped instance exposes its constructor through its prototype.
    // Treat it as another route to mutation, not as an unrelated payload.
    if (value.kind === 'class-ref') return [value.declaration]
    if (value.kind === 'optional') return membersOf(value.payload)
    if (value.kind === 'borrowed-ref') return membersOf(value.referent)
    if (value.kind === 'tagged-union') return value.arms.flatMap((arm) => membersOf(arm.value))
    return []
  }
  const candidates = new Map<
    IrValueId,
    { readonly receiver: DeclarationId; readonly owner: DeclarationId; readonly identity: CallCalleeIdentity }
  >()
  for (const operation of operations) {
    if (operation.kind !== 'get' || operation.receiver.representation.kind !== 'constructor-family') continue
    const members = operation.receiver.representation.members
    // A family with different static implementations needs its own dispatch
    // recipe; the existing static member renderer selects one declaration.
    if (members.length !== 1) continue
    const key = producers.get(operation.key.value)
    if (key?.kind !== 'constant' || key.literal !== 'string') continue
    const receiver = members[0]!
    if (!nativeConstructor(operation.receiver.value, receiver)) continue
    const site = classStaticMemberOf(classes, receiver, key.text)
    if (site?.kind !== 'method' || site.method.callable === null) continue
    candidates.set(operation.result.id, {
      receiver,
      owner: site.owner,
      identity: { kind: 'exact', functionId: site.method.callable }
    })
  }
  const untrusted = new Set<DeclarationId>()
  for (const operation of operations) {
    for (const operand of operandsOfIrOperation(operation)) {
      const members = membersOf(operand.representation)
      if (members.length === 0) continue
      if (
        operand.representation.kind === 'class-ref' &&
        (operation.kind === 'get' || operation.kind === 'set') &&
        operand.value === operation.receiver.value &&
        (operation.kind !== 'set' || operation.value.value !== operand.value)
      ) {
        const key = producers.get(operation.key.value)
        const member =
          key?.kind === 'constant' && key.literal === 'string' ? classMemberOf(classes, operand.representation.declaration, key.text) : null
        if (member?.kind === 'field' || (operation.kind === 'get' && member?.kind === 'method')) continue
      }
      if (operation.kind === 'get' && operand.value === operation.receiver.value && candidates.has(operation.result.id)) continue
      if (operation.kind === 'binding-write') {
        const placement = placements.get(operation.declaration)
        if (
          (placement?.storage.kind === 'local' || placement?.storage.kind === 'region') &&
          placement.representation !== null &&
          representationKey(placement.representation) === representationKey(operand.representation)
        )
          continue
      }
      if (
        operation.kind === 'construct' &&
        (operand.value === operation.callee.value || operand.value === operation.newTarget.value) &&
        !operation.arguments.some((argument) => argument.value === operand.value)
      )
        continue
      if (
        operation.kind === 'call' &&
        operand.value === operation.receiver?.value &&
        candidates.has(operation.callee.value) &&
        !operation.arguments.some((argument) => argument.value === operand.value)
      )
        continue
      if (
        (operation.kind === 'convert' &&
          representationKey(operation.source.representation) === representationKey(operation.result.representation)) ||
        (operation.kind === 'phi' &&
          operation.incoming.every(
            (incoming) => representationKey(incoming.value.representation) === representationKey(operation.result.representation)
          )) ||
        operation.kind === 'test' ||
        (operation.kind === 'compute' &&
          (operation.form === 'typeof' ||
            (operation.form === 'unary' && (operation.operator === 'void' || operation.operator === '!')) ||
            (operation.form === 'equality' && (operation.operator === '===' || operation.operator === '!=='))))
      )
        continue
      // An unknown consumer can walk the constructor's prototype chain and
      // replace an inherited member on an ancestor as well.
      for (const member of members) {
        let declaration: DeclarationId | null = member
        const seen = new Set<DeclarationId>()
        while (declaration !== null && !seen.has(declaration)) {
          untrusted.add(declaration)
          seen.add(declaration)
          declaration = classes.get(declaration)?.base ?? null
        }
      }
    }
  }
  return new Map(
    [...candidates].flatMap(([id, candidate]) => {
      // An intermediate constructor can shadow the inherited method without
      // mutating either the receiver or the original declaring constructor.
      let declaration: DeclarationId | null = candidate.receiver
      const seen = new Set<DeclarationId>()
      while (declaration !== null && !seen.has(declaration)) {
        if (untrusted.has(declaration)) return []
        if (declaration === candidate.owner) return [[id, candidate.identity]]
        seen.add(declaration)
        declaration = classes.get(declaration)?.base ?? null
      }
      return []
    })
  )
}
