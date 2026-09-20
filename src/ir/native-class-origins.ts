import type { DeclarationId, FunctionId, IrValueId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { ClassLayout } from '../projection/classes.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { nativeClassReferenceTransportMatches } from '../conversion/native-class-reference.js'
import { representationKey } from '../representation/model.js'
import type { IrBody, IrOperand, IrOperation } from './model.js'
import { nativeCallFrameOf } from './call-entry.js'
import { classConstructorBodyMatches, constructMatchesAbi } from './construct-entry.js'
import { operandsOfIrOperation } from './queries.js'

/** Allocation provenance is distinct from reflection demand: native callback
 * inputs can have closed layouts without originating in this program. */
export const nativeClassOriginsOf = (
  bodies: readonly IrBody[],
  operations: readonly IrOperation[],
  producers: ReadonlyMap<IrValueId, IrOperation>,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  fieldSources: (operation: Extract<IrOperation, { kind: 'get' }>) => readonly IrOperand[] | null,
  conversions?: Pick<ConversionCensus, 'nodeById'>
): { readonly owned: (id: IrValueId) => boolean; readonly closedInitializer: (id: FunctionId) => boolean } => {
  const writes = new Map<DeclarationId, IrOperand[]>()
  const observed = new Set<IrValueId>()
  const owners = new Map<IrOperation, FunctionId>()
  const bodiesById = new Map<FunctionId, IrBody | null>()
  const local = (id: DeclarationId): boolean => {
    const kind = placements.get(id)?.storage.kind
    return kind === 'local' || kind === 'region'
  }
  for (const body of bodies) {
    const id = body.sourceOwner as FunctionId
    bodiesById.set(id, bodiesById.has(id) ? null : body)
    for (const block of body.blocks.values()) for (const operation of [...block.operations, block.terminator]) owners.set(operation, id)
  }
  for (const operation of operations) {
    for (const operand of operandsOfIrOperation(operation)) observed.add(operand.value)
    if (operation.kind === 'binding-write') {
      const values = writes.get(operation.declaration) ?? []
      values.push(operation.value)
      writes.set(operation.declaration, values)
    }
  }
  const constructorOf = (id: IrValueId, seen = new Set<IrValueId>()): DeclarationId | null => {
    if (seen.has(id)) return null
    const operation = producers.get(id)
    if (operation?.kind === 'allocate-constructor') return operation.declaration
    if (operation?.kind !== 'binding-read' || !local(operation.declaration)) return null
    seen.add(id)
    const values = writes.get(operation.declaration)?.map((value) => constructorOf(value.value, seen))
    seen.delete(id)
    return values?.length && values[0] !== null && values.every((value) => value === values[0]) ? values[0]! : null
  }
  const functionsOf = (id: IrValueId, seen = new Set<IrValueId>()): readonly FunctionId[] => {
    if (seen.has(id)) return []
    const operation = producers.get(id)
    if (operation?.kind === 'allocate-callable') return [operation.functionId]
    const constructor = constructorOf(id)
    if (constructor !== null) {
      const fn = classes.get(constructor)?.constructor
      return fn ? [fn] : []
    }
    if (operation?.kind === 'get' || operation?.kind === 'binding-read') {
      const identity = operation.closedCallable
      if (identity) return identity.kind === 'exact' ? [identity.functionId] : identity.functionIds
    }
    if (operation?.kind !== 'binding-read' || !local(operation.declaration)) return []
    seen.add(id)
    const targets = writes.get(operation.declaration)?.map((value) => functionsOf(value.value, seen))
    seen.delete(id)
    return targets?.length && targets.every((target) => target.length > 0) ? [...new Set(targets.flat())] : []
  }
  const unsafe = new Set<FunctionId>()
  const escapedConstructors = new Set<DeclarationId>()
  const callers = new Map<FunctionId, Extract<IrOperation, { kind: 'call' | 'construct' }>[]>()
  for (const layout of classes.values()) {
    // Super entries and implicit derived constructors require their own incoming
    // frame edges. Do not infer those edges from a matching class signature.
    if (layout.base !== null) {
      escapedConstructors.add(layout.declaration)
      escapedConstructors.add(layout.base)
      if (layout.constructor) unsafe.add(layout.constructor)
      const base = classes.get(layout.base)?.constructor
      if (base) unsafe.add(base)
    }
  }
  for (const operation of operations) {
    for (const operand of operandsOfIrOperation(operation)) {
      const functions = functionsOf(operand.value)
      const constructor = constructorOf(operand.value)
      const stored =
        operation.kind === 'binding-write' &&
        local(operation.declaration) &&
        writes
          .get(operation.declaration)
          ?.every((value) => (constructor !== null ? constructorOf(value.value) === constructor : functionsOf(value.value).length > 0))
      const invoked =
        operation.kind === 'call' &&
        operation.callee.value === operand.value &&
        operation.receiver?.value !== operand.value &&
        !operation.arguments.some((argument) => argument.value === operand.value)
      const constructed =
        operation.kind === 'construct' &&
        operation.callee.value === operand.value &&
        operation.newTarget.value === operand.value &&
        !operation.arguments.some((argument) => argument.value === operand.value)
      if (stored || invoked || constructed) continue
      for (const fn of functions) unsafe.add(fn)
      if (constructor !== null) escapedConstructors.add(constructor)
    }
    if (operation.kind !== 'call' && operation.kind !== 'construct') continue
    const functions = new Set(functionsOf(operation.callee.value))
    if (operation.kind === 'call' && operation.closedCallee) {
      const identity = operation.closedCallee
      for (const fn of identity.kind === 'exact' ? [identity.functionId] : identity.functionIds) functions.add(fn)
    }
    if (operation.kind === 'construct') {
      const targets =
        operation.target.kind === 'exact'
          ? [operation.target.target]
          : operation.target.kind === 'closed-family'
            ? operation.target.targets
            : []
      for (const target of targets) if (target.kind === 'function') functions.add(target.functionId)
    }
    for (const fn of functions) {
      const incoming = callers.get(fn) ?? []
      incoming.push(operation)
      callers.set(fn, incoming)
      const body = bodiesById.get(fn)
      let matched = false
      if (body?.abi && functionsOf(operation.callee.value).includes(fn)) {
        if (operation.kind === 'call') matched = nativeCallFrameOf(operation, body.abi, observed, conversions) !== undefined
        else {
          const declaration = constructorOf(operation.callee.value)
          const layout = declaration === null ? null : classes.get(declaration)
          matched =
            !!layout?.construct &&
            layout.constructor === fn &&
            classConstructorBodyMatches(layout, body) &&
            operation.callee.value === operation.newTarget.value &&
            constructMatchesAbi(operation, layout.construct, conversions)
        }
      }
      if (!matched) unsafe.add(fn)
    }
  }
  const initializedClasses = new Map<FunctionId, DeclarationId[]>()
  for (const layout of classes.values())
    for (const field of layout.fields) {
      if (!field.initializer) continue
      const id = field.initializer as FunctionId
      const declarations = initializedClasses.get(id) ?? []
      declarations.push(layout.declaration)
      initializedClasses.set(id, declarations)
    }
  const closedInitializer = (id: FunctionId): boolean => {
    const declarations = initializedClasses.get(id)
    return !!declarations?.length && !unsafe.has(id) && declarations.every((declaration) => !escapedConstructors.has(declaration))
  }
  const cache = new Map<IrValueId, boolean>()
  const owned = (id: IrValueId, seen = new Set<IrValueId>()): boolean => {
    if (cache.has(id)) return cache.get(id)!
    if (seen.has(id)) return false
    seen.add(id)
    const operation = producers.get(id)
    let sources: readonly IrOperand[] | null = null
    // An absent alternative introduces no foreign object into a nullable
    // reference. Its later presence load still has the conversion's guard.
    let known = operation?.kind === 'constant' && (operation.literal === 'null' || operation.literal === 'undefined')
    if (operation?.kind === 'construct') {
      const declaration = constructorOf(operation.callee.value)
      const layout = declaration === null ? null : classes.get(declaration)
      known =
        !!layout?.construct &&
        declaration !== null &&
        !escapedConstructors.has(declaration) &&
        operation.callee.value === operation.newTarget.value &&
        constructMatchesAbi(operation, layout.construct, conversions) &&
        (layout.constructor === null || (!unsafe.has(layout.constructor) && !!bodiesById.get(layout.constructor)))
    } else if (operation?.kind === 'binding-read' && local(operation.declaration)) sources = writes.get(operation.declaration) ?? null
    else if (operation?.kind === 'phi') sources = operation.incoming.map((incoming) => incoming.value)
    else if (
      operation?.kind === 'convert' &&
      (representationKey(operation.source.representation) === representationKey(operation.result.representation) ||
        nativeClassReferenceTransportMatches(
          operation.source.representation,
          operation.result.representation,
          conversions?.nodeById(operation.conversionUse)
        ))
    )
      sources = [operation.source]
    else if (operation?.kind === 'set') sources = [operation.value]
    else if (operation?.kind === 'define-own-property') sources = [operation.receiver]
    else if (operation?.kind === 'get' && owned(operation.receiver.value, seen)) sources = fieldSources(operation)
    else if (operation?.kind === 'receiver' || operation?.kind === 'parameter') {
      const owner = owners.get(operation)!
      const incoming = callers.get(owner)
      if (!unsafe.has(owner) && incoming?.length) {
        const values = incoming.map((caller) =>
          operation.kind === 'parameter'
            ? caller.arguments[operation.ordinal]
            : caller.kind === 'call'
              ? caller.receiver
              : { value: caller.result.id, representation: caller.result.representation }
        )
        if (values.every((value) => value != null)) sources = values
      }
      // An initializer's implicit receiver is a fresh allocation, but only when
      // its owning constructors cannot be called by an untracked consumer.
      if (operation.kind === 'receiver' && closedInitializer(owner)) known = true
    } else if (operation?.kind === 'call') {
      const functions = functionsOf(operation.callee.value)
      if (functions.length > 0 && functions.every((fn) => !unsafe.has(fn) && bodiesById.get(fn))) {
        const returns = functions.flatMap((fn) =>
          [...bodiesById.get(fn)!.blocks.values()].flatMap((block) => (block.terminator.kind === 'return' ? [block.terminator.value] : []))
        )
        if (returns.length > 0 && returns.every((value) => value !== null)) sources = returns
      }
    }
    if (sources?.length) known = sources.every((source) => owned(source.value, seen))
    seen.delete(id)
    // A recursive path can become known through a later incoming edge. Failed
    // queries are conservative and must not poison an independent query.
    if (known) cache.set(id, true)
    return known
  }
  return { owned, closedInitializer }
}
