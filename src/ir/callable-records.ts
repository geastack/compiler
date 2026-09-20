import type { DeclarationId, FunctionId, IrValueId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import { constructedBaseOf, type ClassLayout } from '../projection/classes.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { CallCalleeIdentity, IrBody, IrOperand, IrOperation } from './model.js'
import { operandsOfIrOperation, resultOfIrOperation } from './queries.js'
import { nativeCallFrameOf } from './call-entry.js'
import { classConstructorBodyMatches, constructMatchesAbi, explicitObjectConstructEntryOf } from './construct-entry.js'
import { callableFieldSlotsOf } from './callable-field-slots.js'
import type { ReflectionExposure } from './reflection-demand.js'

export interface CallableRecordFields {
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  readonly exposure: ReflectionExposure
}

/**
 * Exact callable fields on fresh, unmodified compiler-owned records. Allocation
 * provenance follows owned bindings and the explicit returns of closed
 * factories and the arguments of authenticated native entries. Unknown
 * parameters/host results are never allocation facts, and a write,
 * dynamic read, publication or unknown use of an alias revokes the whole
 * record. These facts authenticate implementations, not direct dispatch:
 * closures still have to be invoked through their stored environments.
 */
export const closedRecordCallablesOf = (
  bodies: readonly IrBody[],
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  callableBindings: ReadonlyMap<DeclarationId, FunctionId>,
  deriver: RepresentationDeriver | null,
  conversions?: Pick<ConversionCensus, 'nodeById'>,
  fieldContext?: CallableRecordFields
): ReadonlyMap<IrValueId, CallCalleeIdentity> => {
  const operations = bodies.flatMap((body) =>
    body.blockOrder.flatMap((id) => {
      const block = body.blocks.get(id)
      return block ? [...block.operations, block.terminator] : []
    })
  )
  const producers = new Map<IrValueId, IrOperation>()
  const writes = new Map<DeclarationId, IrOperand[]>()
  const returns = new Map<FunctionId, readonly IrOperand[] | null>()
  const ownerOf = new Map<IrOperation, FunctionId>()
  const bodyOf = new Map<FunctionId, IrBody | null>()
  const observed = new Set<IrValueId>()
  const local = (declaration: DeclarationId): boolean => {
    const storage = placements.get(declaration)?.storage
    return storage?.kind === 'local' || storage?.kind === 'region'
  }
  const record = (representation: Representation): Extract<Representation, { kind: 'record' }> | null => {
    if (representation.kind === 'optional') return record(representation.payload)
    const layout =
      representation.kind === 'native-record-ref' && representation.native === null && representation.recursive === undefined
        ? deriver?.layoutOf(representation.shapeId as never)
        : representation
    return layout?.kind === 'record' && layout.accessors.length === 0 ? layout : null
  }
  for (const body of bodies) {
    const results: IrOperand[] = []
    let complete = body.abi !== null
    for (const id of body.blockOrder) {
      const block = body.blocks.get(id)
      if (!block) continue
      for (const operation of [...block.operations, block.terminator]) ownerOf.set(operation, body.sourceOwner as FunctionId)
      if (block.terminator.kind === 'return') {
        if (block.terminator.value === null) complete = false
        else results.push(block.terminator.value)
      }
    }
    const id = body.sourceOwner as FunctionId
    bodyOf.set(id, bodyOf.has(id) ? null : body)
    returns.set(id, returns.has(id) || !complete || results.length === 0 ? null : results)
  }
  for (const operation of operations) {
    for (const operand of operandsOfIrOperation(operation)) observed.add(operand.value)
    const result = resultOfIrOperation(operation)
    if (result) producers.set(result.id, operation)
    if (operation.kind === 'binding-write') {
      const values = writes.get(operation.declaration) ?? []
      values.push(operation.value)
      writes.set(operation.declaration, values)
    }
  }
  const keyOf = (operand: IrOperand): string | null => {
    const producer = producers.get(operand.value)
    return producer?.kind === 'constant' && producer.literal === 'string' ? producer.text : null
  }
  const constructorFunctionOf = (id: IrValueId, visiting = new Set<IrValueId>()): FunctionId | null => {
    if (visiting.has(id)) return null
    const producer = producers.get(id)
    if (producer?.kind === 'allocate-constructor') return fieldContext?.classes.get(producer.declaration)?.constructor ?? null
    if (producer?.kind !== 'binding-read' || !local(producer.declaration)) return null
    const values = writes.get(producer.declaration)
    if (!values?.length) return null
    visiting.add(id)
    const targets = values.map((value) => constructorFunctionOf(value.value, visiting))
    visiting.delete(id)
    return targets[0] !== null && targets.every((target) => target === targets[0]) ? targets[0]! : null
  }
  const functionOf = (id: IrValueId): FunctionId | null => {
    const producer = producers.get(id)
    if (producer?.kind === 'allocate-callable') return producer.functionId
    if (producer?.kind === 'binding-read') return callableBindings.get(producer.declaration) ?? constructorFunctionOf(id)
    return constructorFunctionOf(id)
  }
  // A factory handed to an unknown consumer may return its record outside
  // this program. Such an allocation cannot support an immutable-field proof.
  const escapingFunctions = new Set<FunctionId>()
  const allocatedFunctions = new Set(
    operations.flatMap((operation) => (operation.kind === 'allocate-callable' ? [operation.functionId] : []))
  )
  for (const operation of operations) {
    // A published method identity is enough to find an escaping body, but
    // not to pretend every implicit/virtual entry is an ordinary call site.
    if (operation.kind === 'call' && operation.closedCallee) {
      const identity = operation.closedCallee
      const ids = identity.kind === 'exact' ? [identity.functionId] : identity.functionIds
      for (const id of ids) if (functionOf(operation.callee.value) !== id) escapingFunctions.add(id)
    }
    if (operation.kind === 'construct') {
      const targets =
        operation.target.kind === 'exact'
          ? [operation.target.target]
          : operation.target.kind === 'closed-family'
            ? operation.target.targets
            : []
      for (const target of targets)
        if (target.kind === 'function' && functionOf(operation.callee.value) !== target.functionId) escapingFunctions.add(target.functionId)
    }
    for (const operand of operandsOfIrOperation(operation)) {
      const producer = producers.get(operand.value)
      const identity = producer?.kind === 'get' ? producer.closedCallable : undefined
      if (
        identity &&
        !(
          operation.kind === 'call' &&
          operation.callee.value === operand.value &&
          operation.receiver?.value !== operand.value &&
          !operation.arguments.some((argument) => argument.value === operand.value)
        )
      )
        for (const id of identity.kind === 'exact' ? [identity.functionId] : identity.functionIds) escapingFunctions.add(id)
      const callable = functionOf(operand.value)
      if (callable === null) continue
      if (operation.kind === 'binding-write' && callableBindings.get(operation.declaration) === callable) continue
      if (
        operation.kind === 'binding-write' &&
        local(operation.declaration) &&
        constructorFunctionOf(operation.value.value) === callable &&
        writes.get(operation.declaration)?.every((value) => constructorFunctionOf(value.value) === callable)
      )
        continue
      if (
        operation.kind === 'call' &&
        operation.callee.value === operand.value &&
        operation.receiver?.value !== operand.value &&
        !operation.arguments.some((argument) => argument.value === operand.value)
      )
        continue
      if (
        operation.kind === 'construct' &&
        operation.callee.value === operand.value &&
        operation.newTarget.value === operand.value &&
        !operation.arguments.some((argument) => argument.value === operand.value)
      )
        continue
      escapingFunctions.add(callable)
    }
  }
  // A signature cannot prove implementation identity. Only allocated functions
  // and their unique owned bindings may contribute parameter sources here.
  const callers = new Map<FunctionId, IrOperation[]>()
  const receivedParameters = new Map<IrOperation, readonly IrValueId[]>()
  const unknownEntries = new Set<FunctionId>()
  // Base constructors also receive super-initialize and implicit-derived
  // entries, which are not represented by the ordinary caller map below.
  for (const layout of fieldContext?.classes.values() ?? []) {
    const base = constructedBaseOf(layout)
    const constructor = base === null ? null : fieldContext?.classes.get(base)?.constructor
    if (constructor) unknownEntries.add(constructor)
  }
  for (const operation of operations) {
    if (operation.kind !== 'call' && operation.kind !== 'construct') continue
    const callable = functionOf(operation.callee.value)
    if (callable === null) continue
    const body = bodyOf.get(callable)
    const abi = body?.abi
    const incoming = callers.get(callable) ?? []
    incoming.push(operation)
    callers.set(callable, incoming)
    let matched = false
    if (body && abi) {
      if (operation.kind === 'call') matched = nativeCallFrameOf(operation, abi, observed, conversions) !== undefined
      else {
        const target = operation.target
        const entry = explicitObjectConstructEntryOf(operation, abi)
        const construct = entry?.abi ?? body.construct
        const classLayouts = fieldContext ? [...fieldContext.classes.values()].filter((layout) => layout.constructor === callable) : []
        matched =
          target.kind === 'exact' &&
          target.target.kind === 'function' &&
          target.target.functionId === callable &&
          target.target.constructable &&
          construct !== null &&
          constructMatchesAbi(operation, construct, conversions) &&
          construct.restFrom === abi.restFrom &&
          construct.parameters.length === abi.parameters.length &&
          construct.parameters.every(
            (parameter, index) => representationKey(parameter.value) === representationKey(abi.parameters[index]!.value)
          )
        if (classLayouts.length > 0)
          matched =
            target.kind === 'exact' &&
            target.target.kind === 'function' &&
            target.target.functionId === callable &&
            classLayouts.every(
              (layout) =>
                layout.construct !== null &&
                classConstructorBodyMatches(layout, body) &&
                constructMatchesAbi(operation, layout.construct, conversions)
            )
      }
      if (matched) {
        const parameters = new Map<number, IrValueId>()
        for (const block of body.blocks.values())
          for (const parameter of block.operations)
            if (parameter.kind === 'parameter') parameters.set(parameter.ordinal, parameter.result.id)
        // No argument may disappear into an untracked formal. Extra fixed
        // arguments are evaluated but the shared entry says the body ignores them.
        if (abi.parameters.every((_, index) => parameters.has(index)))
          receivedParameters.set(
            operation,
            abi.parameters.map((_, index) => parameters.get(index)!)
          )
        else matched = false
      }
    }
    if (!matched) unknownEntries.add(callable)
  }
  const fieldSlots = callableFieldSlotsOf(
    bodies,
    operations,
    producers,
    fieldContext?.classes ?? new Map(),
    fieldContext?.exposure,
    (value) => record(value) !== null,
    placements,
    deriver,
    conversions
  )
  const rootCache = new Map<IrValueId, ReadonlySet<IrValueId> | null>()
  const rootsOf = (id: IrValueId, visiting = new Set<IrValueId>()): ReadonlySet<IrValueId> | null => {
    if (rootCache.has(id)) return rootCache.get(id)!
    if (visiting.has(id)) return null
    visiting.add(id)
    const producer = producers.get(id)
    const result = producer && resultOfIrOperation(producer)
    let sources: readonly IrOperand[] | null = null
    let roots: ReadonlySet<IrValueId> | null = null
    if (producer?.kind === 'constant' && (producer.literal === 'undefined' || producer.literal === 'null')) roots = new Set()
    else if (result && record(result.representation)) {
      if (producer.kind === 'allocate-record' || producer.kind === 'allocate-ordinary-object') roots = new Set([id])
      else if (producer.kind === 'binding-read' && local(producer.declaration)) sources = writes.get(producer.declaration) ?? null
      else if (producer.kind === 'get') sources = fieldSlots.reads.get(producer.result.id) ?? null
      else if (producer.kind === 'set' && fieldSlots.stores.has(producer)) sources = [producer.value]
      else if (producer.kind === 'parameter') {
        const owner = ownerOf.get(producer)!
        const incoming = callers.get(owner)
        if (!escapingFunctions.has(owner) && !unknownEntries.has(owner) && incoming?.length) {
          const arguments_ = incoming.map((caller) =>
            caller.kind === 'call' || caller.kind === 'construct' ? caller.arguments[producer.ordinal] : undefined
          )
          if (arguments_.every((argument) => argument !== undefined)) sources = arguments_
        }
      } else if (producer.kind === 'phi') sources = producer.incoming.map((incoming) => incoming.value)
      // DefineOwnProperty returns the same object. Object literals commonly
      // return the last definition's SSA result rather than the allocator.
      // Non-initial definitions still revoke every alias in the escape scan.
      else if (producer.kind === 'define-own-property') sources = [producer.receiver]
      else if (producer.kind === 'convert') {
        const source = record(producer.source.representation)
        const target = record(result.representation)
        // This is only a wrapper/view of the identical native record shape.
        // Rebuilding a different shape does not preserve this allocation.
        if (source && target && representationKey(source) === representationKey(target)) sources = [producer.source]
      } else if (producer.kind === 'call' || producer.kind === 'construct') {
        const callable = functionOf(producer.callee.value)
        if (callable !== null && !escapingFunctions.has(callable)) sources = returns.get(callable) ?? null
        // A constructor returning undefined/null uses its implicit receiver.
        // Only explicit, non-optional object returns authenticate this result.
        if (
          producer.kind === 'construct' &&
          sources?.some((source) => source.representation.kind === 'optional' || !record(source.representation))
        )
          sources = null
      }
    }
    if (sources !== null && sources.length > 0) {
      const combined = new Set<IrValueId>()
      let complete = true
      for (const source of sources) {
        const nested = rootsOf(source.value, visiting)
        if (nested === null) {
          complete = false
          break
        }
        for (const root of nested) combined.add(root)
      }
      if (complete) roots = combined
    }
    visiting.delete(id)
    rootCache.set(id, roots)
    return roots
  }
  const initializers = new Map<IrValueId, Map<string, IrOperand | null>>()
  const initializationOps = new Set<IrOperation>()
  const addField = (id: IrValueId, key: string, value: IrOperand): void => {
    const fields = initializers.get(id) ?? new Map<string, IrOperand | null>()
    fields.set(key, fields.has(key) ? null : value)
    initializers.set(id, fields)
  }
  for (const body of bodies)
    for (const id of body.blockOrder) {
      const block = body.blocks.get(id)
      if (!block) continue
      const initializing = new Set<IrValueId>()
      for (const operation of block.operations) {
        if (
          (operation.kind === 'allocate-record' || operation.kind === 'allocate-ordinary-object') &&
          record(operation.result.representation)
        ) {
          initializing.add(operation.result.id)
          initializers.set(operation.result.id, new Map())
          if (operation.kind === 'allocate-record')
            for (const field of operation.fields) addField(operation.result.id, field.key, field.value)
        }
        const key = operation.kind === 'define-own-property' ? keyOf(operation.key) : null
        if (operation.kind === 'define-own-property' && key !== null && initializing.has(operation.receiver.value)) {
          addField(operation.receiver.value, key, operation.value)
          initializationOps.add(operation)
        }
        for (const operand of operandsOfIrOperation(operation)) {
          if (operation.kind === 'define-own-property' && initializationOps.has(operation) && operand.value === operation.receiver.value)
            continue
          initializing.delete(operand.value)
        }
      }
    }
  const escaped = new Set<IrValueId>()
  for (const operation of operations)
    for (const operand of operandsOfIrOperation(operation)) {
      const roots = rootsOf(operand.value)
      if (!roots || roots.size === 0) continue
      if (
        operation.kind === 'binding-write' &&
        local(operation.declaration) &&
        writes.get(operation.declaration)?.every((value) => rootsOf(value.value) !== null)
      )
        continue
      if (operation.kind === 'return' && allocatedFunctions.has(ownerOf.get(operation)!) && !escapingFunctions.has(ownerOf.get(operation)!))
        continue
      if (fieldSlots.initializerReturns.has(operation)) continue
      if (
        (operation.kind === 'set' || operation.kind === 'define-own-property') &&
        operand.value === operation.value.value &&
        fieldSlots.stores.get(operation)?.every((source) => rootsOf(source.value) !== null)
      )
        continue
      if (operation.kind === 'convert' && rootsOf(operation.result.id) !== null) continue
      if (operation.kind === 'phi' && rootsOf(operation.result.id) !== null) continue
      if (operation.kind === 'allocate-callable' && bodyOf.get(operation.functionId)) continue
      if (operation.kind === 'call' || operation.kind === 'construct') {
        const parameters = receivedParameters.get(operation)
        const callable = functionOf(operation.callee.value)
        if (
          parameters &&
          callable !== null &&
          !escapingFunctions.has(callable) &&
          !unknownEntries.has(callable) &&
          operand.value !== operation.callee.value &&
          (operation.kind === 'construct' ? operand.value !== operation.newTarget.value : operand.value !== operation.receiver?.value) &&
          operation.arguments.every(
            (argument, index) => argument.value !== operand.value || index >= parameters.length || rootsOf(parameters[index]!) !== null
          )
        )
          continue
      }
      if (operation.kind === 'get' && operand.value === operation.receiver.value) {
        const key = keyOf(operation.key)
        if (key !== null && [...roots].every((root) => initializers.get(root)?.get(key))) continue
      }
      if (initializationOps.has(operation) && operation.kind === 'define-own-property' && operand.value === operation.receiver.value)
        continue
      if (
        operation.kind === 'test' ||
        (operation.kind === 'compute' &&
          (operation.form === 'typeof' ||
            (operation.form === 'unary' && (operation.operator === '!' || operation.operator === 'void')) ||
            (operation.form === 'equality' && (operation.operator === '===' || operation.operator === '!=='))))
      )
        continue
      for (const root of roots) escaped.add(root)
    }
  const result = new Map<IrValueId, CallCalleeIdentity>()
  for (const operation of operations) {
    if (operation.kind !== 'get') continue
    const key = keyOf(operation.key)
    const roots = rootsOf(operation.receiver.value)
    if (key === null || !roots || roots.size === 0) continue
    const functions = new Set<FunctionId>()
    let complete = true
    for (const root of roots) {
      const value = initializers.get(root)?.get(key)
      const callable = value ? functionOf(value.value) : null
      if (escaped.has(root) || callable === null) {
        complete = false
        break
      }
      functions.add(callable)
    }
    if (complete && functions.size > 0)
      result.set(
        operation.result.id,
        functions.size === 1 ? { kind: 'exact', functionId: [...functions][0]! } : { kind: 'closed-family', functionIds: [...functions] }
      )
  }
  return result
}
