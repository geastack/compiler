import type { DeclarationId, FunctionId, IrValueId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import { classLayoutOfCopy, type ClassLayout } from '../projection/classes.js'
import { classFamilyOverridesOf, extendsClass } from '../projection/dispatch.js'
import { classMemberOf } from '../projection/fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, walkRepresentation, type Representation } from '../representation/model.js'
import type { NativeCallableFlow } from './callable-class-flow.js'
import { allOperationsOf, type IrBody, type IrOperation } from './model.js'
import { resultOfIrOperation } from './queries.js'
import { constantPropertyKeyTextOf } from './native-property-key-texts.js'

/** Exact native allocations and allocations an unknown observer may create. Base initialization is a separate demand.
 * The caller supplies the one callable flow over exactly these bodies. */
export const classAllocationDomainOf = (
  bodies: readonly IrBody[],
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  deriver: RepresentationDeriver,
  flow: Pick<NativeCallableFlow, 'dynamicReceiverValues'>
): ReadonlySet<DeclarationId> => {
  const allocations = new Set<DeclarationId>()
  const constructorOwners = new Map<FunctionId, DeclarationId[]>()
  for (const [declaration, layout] of classes)
    if (layout.constructor !== null) {
      const owners = constructorOwners.get(layout.constructor) ?? []
      owners.push(declaration)
      constructorOwners.set(layout.constructor, owners)
    }
  const addClass = (declaration: DeclarationId): void => {
    const layout = classLayoutOfCopy(classes, declaration)
    if (layout) allocations.add(layout.declaration)
  }
  // An unknown observer can recover every constructor along an instance's
  // prototype chain, including a bodyless base declaration's constructor --
  // but only from an instance that exists. A value it receives whose type is
  // a class names that class's family, not an allocation of it: hono's `Context`
  // reaches an `executionCtx?: FetchEventLike` that nothing ever constructs,
  // and treating the type as an instance made the abstract class allocatable
  // and its bodyless `respondWith` an evaluated read. So a received class type
  // records the family, and the chains are recovered once the construct sites
  // are known (below).
  const exposedFamilies = new Set<DeclarationId>()
  const exposeClass = (declaration: DeclarationId): void => {
    const layout = classLayoutOfCopy(classes, declaration)
    if (layout) exposedFamilies.add(layout.declaration)
  }
  /** A constructor the observer is handed: it can construct that class itself. */
  const exposeConstructor = (declaration: DeclarationId): void => {
    addClass(declaration)
    exposeClass(declaration)
  }
  const exposed = new Set<string>()
  const expose = (representation: Representation): void => {
    const pending = [representation]
    while (pending.length > 0) {
      const value = pending.pop()!
      const key = representationKey(value)
      if (exposed.has(key)) continue
      exposed.add(key)
      for (const carrier of walkRepresentation(value)) {
        if (carrier.kind === 'class-ref') {
          exposeClass(carrier.declaration)
          const shape = deriver.layoutOf(carrier.shapeId as never)
          if (shape) pending.push(shape)
        }
        if (carrier.kind === 'constructor-family') for (const member of carrier.members) exposeConstructor(member)
        if (carrier.kind === 'native-record-ref' && carrier.native === null) {
          const shape = deriver.layoutOf(carrier.shapeId as never)
          if (shape) pending.push(shape)
        }
      }
    }
  }
  // A class's own declared data field read as the `any` it is declared --
  // hono's `const { bodyCache } = this`, a `Partial<Body>` whose `json: any`
  // makes the field dynamic -- is a load from the instance's slot. It hands
  // no observer the instance: the Value it yields was exposed when stored.
  let definitions = new Map<IrValueId, IrOperation>()
  const declaredDataFieldRead = (operation: Extract<IrOperation, { readonly kind: 'get' }>): boolean => {
    const receiver = operation.receiver.representation
    if (receiver.kind !== 'class-ref') return false
    const key = constantPropertyKeyTextOf(definitions.get(operation.key.value))
    if (key === null) return false
    return (
      classMemberOf(classes, receiver.declaration, key)?.kind === 'field' &&
      classFamilyOverridesOf(classes, receiver.declaration, key).length === 0
    )
  }
  const dynamicReceivers = flow.dynamicReceiverValues
  for (const body of bodies) {
    definitions = new Map()
    for (const block of body.blocks.values())
      for (const operation of allOperationsOf(block)) {
        const result = resultOfIrOperation(operation)
        if (result !== null) definitions.set(result.id, operation)
      }
    for (const block of body.blocks.values())
      for (const operation of allOperationsOf(block)) {
        if (operation.kind === 'construct') {
          const targets =
            operation.target.kind === 'exact'
              ? [operation.target.target]
              : operation.target.kind === 'closed-family'
                ? operation.target.targets
                : null
          if (targets !== null)
            for (const target of targets)
              if (target.kind === 'function') for (const owner of constructorOwners.get(target.functionId) ?? []) addClass(owner)
              else addClass(target.classDeclaration)
          else if (operation.callee.representation.kind === 'constructor-family')
            for (const member of operation.callee.representation.members) addClass(member)
          else if (operation.callee.representation.kind !== 'native-handle') for (const declaration of classes.keys()) addClass(declaration)
        }
        if (operation.kind === 'convert') {
          if (operation.result.representation.kind === 'dynamic') expose(operation.source.representation)
          if (operation.source.representation.kind === 'dynamic') expose(operation.result.representation)
        }
        if (operation.kind === 'get' && operation.result.representation.kind === 'dynamic' && !declaredDataFieldRead(operation))
          expose(operation.receiver.representation)
        if (
          operation.kind === 'call' &&
          (operation.callee.representation.kind === 'dynamic' || dynamicReceivers.has(operation.callee.value))
        ) {
          if (operation.receiver) expose(operation.receiver.representation)
          if (operation.thisArgument) expose(operation.thisArgument.representation)
          for (const argument of operation.arguments) expose(argument.representation)
          if (operation.result) expose(operation.result.representation)
        }
        if (operation.kind === 'binding-read' && placements.get(operation.declaration)?.storage.kind === 'external')
          expose(operation.result.representation)
      }
  }
  for (let grown = true; grown;) {
    grown = false
    for (const family of exposedFamilies)
      for (const allocation of [...allocations]) {
        if (allocation !== family && !extendsClass(classes, allocation, family)) continue
        const seen = new Set<DeclarationId>()
        for (
          let current: DeclarationId | null = classes.get(allocation)?.base ?? null;
          current !== null && !seen.has(current);
          current = classes.get(current)?.base ?? null
        ) {
          seen.add(current)
          const layout = classLayoutOfCopy(classes, current)
          if (layout && !allocations.has(layout.declaration)) {
            allocations.add(layout.declaration)
            grown = true
          }
        }
      }
  }
  return allocations
}
