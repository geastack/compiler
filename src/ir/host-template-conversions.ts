import type { ConversionNode } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { recipeIsMaterializableWithoutPriorSourceGuard } from '../conversion/recipe-closure.js'
import { structuralConversionKey } from '../conversion/structural-plan.js'
import type { DeclarationId, IrValueId, StructuralTypeId } from '../identity/ids.js'
import { abiOfCallee } from '../projection/callee.js'
import type { ClassLayout } from '../projection/classes.js'
import { declaredRecordFieldOf, nativeBaseFieldOf, recordFieldsOfShape } from '../projection/fields.js'
import { canonicalIndexLiteral } from '../representation/array-index.js'
import { isNativeCallableCarrier } from '../representation/callable-object.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { hostReceiverProtocolOf } from '../representation/host-templates.js'
import { representationKey, type RecordField, type Representation } from '../representation/model.js'
import { hostMemberOf, type HostSpellings } from '../targets/cpp/host/host-members.js'
import type { CallOperation, IrOperand, IrOperation } from './model.js'
import { indexedRecordViewOf } from './certify/carrier-keys.js'
import { nativePrototypeCallClaimsOf } from './native-prototype-calls.js'
import type { HostMethodAlias } from './host-method-aliases.js'
import type { OperationConversionInput } from './operation-conversions.js'

const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const number: Representation = { kind: 'scalar', domain: 'number' }
const string: Representation = { kind: 'string' }
const undefinedValue: Representation = { kind: 'undefined' }

/** A host row is authenticated by the producer of the callee, never its C++ spelling. */
export const hostTemplateMemberOf = (
  operation: CallOperation,
  definitionOf: (value: IrValueId) => IrOperation | null,
  aliases?: ReadonlyMap<DeclarationId, HostMethodAlias>
): { readonly protocol: string; readonly member: string } | null => {
  if (operation.hostTemplate === 'object-assign') return { protocol: 'ObjectConstructor', member: 'assign' }
  const read = definitionOf(operation.callee.value)
  if (read?.kind === 'binding-read') return aliases?.get(read.declaration) ?? null
  if (read?.kind !== 'get') return null
  const protocol = read.hostMethod?.protocol ?? hostReceiverProtocolOf(read.receiver.representation)?.protocol ?? null
  const key = definitionOf(read.key.value)
  const member = read.hostMethod?.member ?? (key?.kind === 'constant' && key.literal === 'string' ? key.text : null)
  return protocol === null || member === null ? null : { protocol, member }
}

/** A public element carrier does not describe an original data descriptor.
 * Until its snapshot reader is selected, the exact installed live array
 * provenance must stop this template before it can sample target storage.
 */
export const nativeArrayDescriptorSnapshotRequired = (
  operation: CallOperation,
  definitionOf: (value: IrValueId) => IrOperation | null,
  liveValues: ReadonlySet<IrValueId> | undefined,
  aliases?: ReadonlyMap<DeclarationId, HostMethodAlias>
): boolean => {
  const source = operation.arguments[0]
  const carriesArray = (value: Representation): boolean =>
    value.kind === 'array-object' ||
    (value.kind === 'optional' && carriesArray(value.payload)) ||
    (value.kind === 'tagged-union' && value.arms.some((arm) => carriesArray(arm.value)))
  if (source === undefined || !carriesArray(source.representation) || liveValues?.has(source.value) !== true) return false
  const host = hostTemplateMemberOf(operation, definitionOf, aliases)
  return host?.protocol === 'ObjectConstructor' && host.member === 'getOwnPropertyDescriptor'
}

const leavesOf = (value: Representation): readonly Representation[] =>
  value.kind === 'optional'
    ? leavesOf(value.payload)
    : value.kind === 'tagged-union'
      ? value.arms.flatMap((arm) => leavesOf(arm.value))
      : [value]

const knownFieldsOf = (deriver: RepresentationDeriver, value: Representation): readonly RecordField[] | null =>
  value.kind === 'record' || value.kind === 'record-with-index'
    ? value.fields
    : value.kind === 'class-ref' || (value.kind === 'native-record-ref' && value.native === null)
      ? recordFieldsOfShape(deriver, value.shapeId)
      : null

const entryValueOf = (deriver: RepresentationDeriver, value: Representation): Representation | null => {
  if (value.kind === 'array-object' && value.element.kind === 'string' && value.ownership === 'shared-refcount') return value.element
  const fields = knownFieldsOf(deriver, value)
  const [first, second] = fields ?? []
  return fields?.length === 2 && first?.key === '0' && first.value.kind === 'string' && second?.key === '1' ? second.value : null
}

const descriptorValueOf = (deriver: RepresentationDeriver, result: Representation | undefined): Representation | null => {
  const payload = result?.kind === 'optional' ? result.payload : result
  return payload === undefined ? null : (knownFieldsOf(deriver, payload)?.find((field) => field.key === 'value')?.value ?? null)
}

/** Internal template stores and callback arguments, independent of the ambient callable ABI. */
export const hostTemplateConversionInputsOf = (
  operation: CallOperation,
  definitionOf: (value: IrValueId) => IrOperation | null,
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  hosts?: Pick<HostSpellings, 'members'>,
  aliases?: ReadonlyMap<DeclarationId, HostMethodAlias>
): readonly OperationConversionInput[] => {
  if (operation.nativeArrayDescriptorSnapshot || operation.nativeArrayDescriptorReinstallation) return []
  const inputs = new Map<string, OperationConversionInput>()
  const add = (role: OperationConversionInput['role'], source: Representation, target: Representation): void => {
    if (representationKey(source) === representationKey(target)) return
    inputs.set(`${role}:${structuralConversionKey(source, target)}`, { role, source, target })
  }
  const result = operation.result?.representation
  for (const claim of nativePrototypeCallClaimsOf(operation, definitionOf, classes, deriver) ?? []) {
    const carrier = claim.carrier
    const member = claim.member
    if (carrier.kind === 'array-object') {
      const element = carrier.element
      if (member === 'push' || member === 'unshift') {
        const packed = operation.arguments[0]?.representation
        if (packed?.kind === 'array-object') add('prototype-argument', packed.element, element)
      }
      if (['map', 'filter', 'forEach', 'find', 'findIndex', 'findLast', 'findLastIndex', 'some', 'every', 'flatMap'].includes(member)) {
        const callback = operation.arguments[0]?.representation
        if (callback?.kind === 'function-value-dispatch' && callback.abi.receiver === null && callback.abi.parameters[0])
          add('prototype-callback', element, callback.abi.parameters[0].value)
      }
      if (result && ['find', 'findLast', 'at', 'pop', 'shift'].includes(member))
        add('prototype-result', { kind: 'optional', payload: element, absence: 'undefined' }, result)
      if (member === 'filter' && result?.kind === 'array-object') add('prototype-result', element, result.element)
      if (
        member === 'flat' &&
        element.kind === 'record' &&
        deriver.isTupleShape(element.shapeId as StructuralTypeId) &&
        result?.kind === 'array-object'
      )
        for (const field of element.fields) add('prototype-result', field.value, result.element)
      if (member === 'includes') {
        const search = operation.arguments[0]?.representation
        if (search && element.kind === 'tagged-union') {
          const arms = new Set(element.arms.map((arm) => representationKey(arm.value)))
          const searches = search.kind === 'tagged-union' ? search.arms.map((arm) => arm.value) : [search]
          if (searches.every((value) => arms.has(representationKey(value)))) add('prototype-argument', search, element)
        } else if (search?.kind === 'function-value-dispatch' && element.kind === 'function-value-dispatch')
          add('prototype-argument', search, element)
      }
      if (result?.kind === 'iterator') {
        if (member === 'keys') add('prototype-result', number, result.element)
        if (member === 'values') add('prototype-result', element, result.element)
        if (member === 'entries') {
          const yielded = result.element
          if (yielded.kind === 'array-object') {
            add('prototype-result', number, yielded.element)
            add('prototype-result', element, yielded.element)
          } else if (yielded.kind === 'record' && yielded.fields.length === 2) {
            const [first, second] = yielded.fields
            if (first?.key === '0' && second?.key === '1' && first.required && second.required) {
              add('prototype-result', number, first.value)
              add('prototype-result', element, second.value)
            }
          }
        }
      }
    }
    if (member === 'valueOf' && result && (carrier.kind === 'string' || carrier.kind === 'scalar')) {
      const read = definitionOf(operation.callee.value)
      const source = read?.kind === 'get' ? read.receiver.representation : null
      if (source?.kind === 'tagged-union') add('prototype-result', carrier, result)
    }
    if (carrier.kind === 'typed-array' && result) {
      const read = definitionOf(operation.callee.value)
      const source = read?.kind === 'get' ? read.receiver.representation : null
      if (source?.kind === 'tagged-union')
        add('prototype-result', member === 'set' ? undefinedValue : member === 'toBase64' ? string : carrier, result)
    }
  }
  const host = hostTemplateMemberOf(operation, definitionOf, aliases)
  if (host && hosts) {
    const row = hostMemberOf(hosts.members, host.protocol, host.member)
    if (row?.kind === 'method' && row.arity === 'pass-through') {
      const abi = abiOfCallee(operation.callee.representation)
      for (const [ordinal, argument] of operation.arguments.entries()) {
        if (argument.representation.kind !== 'dynamic') continue
        const parameter = abi?.parameters[ordinal]?.value
        const into = parameter?.kind === 'optional' ? parameter.payload : parameter
        if (into?.kind === 'scalar' || into?.kind === 'string') add('prototype-argument', argument.representation, into)
      }
    }
  }
  if (host === null || (host.protocol !== 'ObjectConstructor' && host.protocol !== 'Reflect' && host.protocol !== 'gea::ReflectNamespace'))
    return [...inputs.values()]
  const source = operation.arguments[0]?.representation
  if (source === undefined) return [...inputs.values()]
  const sources = leavesOf(source)
  if ((host.member === 'ownKeys' || host.member === 'getOwnPropertySymbols') && result?.kind === 'array-object') {
    if (host.member === 'ownKeys') add('prototype-result', string, result.element)
    add('prototype-result', { kind: 'symbol' }, result.element)
  }
  if (host.member === 'values' && result?.kind === 'array-object')
    for (const value of sources) {
      const fields = knownFieldsOf(deriver, value)
      if (fields) for (const field of fields) add('prototype-result', field.value, result.element)
    }
  if (host.member === 'entries' && result?.kind === 'array-object') {
    const target = entryValueOf(deriver, result.element)
    if (target)
      for (const value of sources) {
        if (value.kind === 'dynamic') add('prototype-result', dynamic, target)
        else if (value.kind === 'dictionary') {
          if (value.key !== 'symbol') add('prototype-result', value.value, target)
        } else if (value.kind === 'array-object') {
          add('prototype-result', value.element, target)
          add('prototype-result', dynamic, target)
        } else for (const field of knownFieldsOf(deriver, value) ?? []) add('prototype-result', field.value, target)
      }
  }
  if (host.member === 'assign' && operation.nativeOwnAssignment === undefined) {
    const target = source.kind === 'optional' ? source.payload : source
    for (const operand of operation.arguments.slice(1))
      for (const value of leavesOf(operand.representation)) {
        const fields = knownFieldsOf(deriver, value)
        if (target.kind === 'dictionary') {
          if (value.kind === 'dictionary') add('prototype-argument', value.value, target.value)
          else if (value.kind === 'dynamic' && target.key === 'string') add('prototype-argument', dynamic, target.value)
          else if (fields && target.key !== 'symbol')
            for (const field of fields)
              if (!nativeBaseFieldOf(deriver, value, field.key, classes)) add('prototype-argument', field.value, target.value)
        } else if (fields && !isNativeCallableCarrier(target.kind))
          for (const field of fields) {
            if (nativeBaseFieldOf(deriver, value, field.key, classes)) continue
            const into = target.kind === 'dynamic' ? dynamic : declaredRecordFieldOf(deriver, target, field.key, classes)?.value
            if (into) add('prototype-argument', field.value, into)
            else if ('ownership' in target && target.ownership === 'shared-refcount') add('prototype-argument', field.value, dynamic)
          }
      }
  }
  if (host.member === 'fromEntries' && result?.kind === 'dictionary') {
    const pair = source.kind === 'array-object' || source.kind === 'iterator' ? source.element : null
    if (pair?.kind === 'array-object') add('prototype-result', pair.element, result.value)
    else if (pair) {
      const fields = knownFieldsOf(deriver, pair)
      const [first, second] = fields ?? []
      if (fields?.length === 2 && first?.key === '0' && second?.key === '1' && first.required && second.required)
        add('prototype-result', second.value, result.value)
    }
  }
  if (host.member === 'getOwnPropertyDescriptor') {
    const into = descriptorValueOf(deriver, result)
    const key = operation.arguments[1] && definitionOf(operation.arguments[1].value)
    const text = key?.kind === 'constant' && (key.literal === 'string' || key.literal === 'number') ? key.text : null
    if (into)
      for (const value of sources) {
        if (value.kind === 'array-object') {
          if (text === null || text === 'length') add('prototype-result', number, into)
          if (text === null || canonicalIndexLiteral(text) !== null) add('prototype-result', value.element, into)
          if (text === null || (text !== 'length' && canonicalIndexLiteral(text) === null))
            add('prototype-result', { kind: 'dynamic', reason: 'opt-in-fallback' }, into)
        } else {
          const fields = knownFieldsOf(deriver, value)
          if (fields && indexedRecordViewOf(deriver, value) === null) {
            if (text === null) {
              for (const field of fields) add('prototype-result', field.value, into)
              add('prototype-result', dynamic, into)
            } else {
              const field = fields.find((field) => field.key === text)
              add('prototype-result', field?.value ?? dynamic, into)
            }
          } else add('prototype-result', dynamic, into)
        }
      }
  }
  return [...inputs.values()]
}

export interface HostObjectWalkPlan {
  readonly member: string
  /** Only complete admitted callbacks are present. Omitted routes retain their static copy. */
  readonly routes: ReadonlyMap<string, ReadonlyMap<string, ConversionNode>>
}

export const hostObjectRouteKey = (source: Representation, destination: string): string => `${representationKey(source)}|${destination}`

/** The operands whose own properties a planned walk enumerates and reads: `values`/`entries`' receiver, `assign`'s sources. */
export const hostObjectWalkedSourcesOf = (operation: CallOperation): readonly IrOperand[] => {
  switch (operation.hostObjectWalkPlan?.member) {
    case 'values':
    case 'entries':
      return operation.arguments.slice(0, 1)
    case 'assign':
      return operation.arguments.slice(1)
    default:
      return []
  }
}

/** Optional own-key walks are selected before certification, including their entire callback frame. */
export const hostObjectWalkPlanOf = (
  operation: CallOperation,
  definitionOf: (value: IrValueId) => IrOperation | null,
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  census: Pick<ConversionCensus, 'nodeFor' | 'nodeById'>,
  aliases?: ReadonlyMap<DeclarationId, HostMethodAlias>
): HostObjectWalkPlan | undefined => {
  if (
    operation.nativeOwnAssignment !== undefined ||
    operation.nativeArrayDescriptorSnapshot !== undefined ||
    operation.nativeArrayDescriptorReinstallation !== undefined
  )
    return undefined
  const host = hostTemplateMemberOf(operation, definitionOf, aliases)
  if (
    host === null ||
    host.protocol !== 'ObjectConstructor' ||
    !['values', 'entries', 'assign', 'getOwnPropertyDescriptor'].includes(host.member)
  )
    return undefined
  const routes = new Map<string, ReadonlyMap<string, ConversionNode>>()
  const admit = (source: Representation, destination: string, targets: readonly Representation[], from: Representation = dynamic): void => {
    const nodes = targets.map((target) => census.nodeFor(from, target))
    if (!nodes.every((node) => recipeIsMaterializableWithoutPriorSourceGuard(node, census.nodeById))) return
    routes.set(
      hostObjectRouteKey(source, destination),
      new Map(nodes.map((node) => [structuralConversionKey(node.source, node.target), node]))
    )
  }
  const result = operation.result?.representation
  const source = operation.arguments[0]?.representation
  if (source !== undefined && (host.member === 'values' || host.member === 'entries') && result?.kind === 'array-object') {
    const into = host.member === 'values' ? result.element : entryValueOf(deriver, result.element)
    if (into)
      for (const value of leavesOf(source))
        if (knownFieldsOf(deriver, value) !== null && 'ownership' in value && value.ownership === 'shared-refcount')
          admit(value, host.member, [into])
  }
  if (source !== undefined && host.member === 'assign') {
    const target = source.kind === 'optional' ? source.payload : source
    const shared = 'ownership' in target && target.ownership === 'shared-refcount'
    const fields = knownFieldsOf(deriver, target)
    const targets =
      target.kind === 'dictionary'
        ? [target.value]
        : target.kind === 'dynamic'
          ? []
          : shared && fields !== null
            ? [
                ...fields
                  .filter((field) => !field.key.startsWith('sym('))
                  .map((field) => declaredRecordFieldOf(deriver, target, field.key, classes)?.value ?? field.value),
                dynamic
              ]
            : null
    if (targets !== null)
      for (const operand of operation.arguments.slice(1))
        for (const value of leavesOf(operand.representation))
          if (knownFieldsOf(deriver, value) !== null && 'ownership' in value && value.ownership === 'shared-refcount')
            admit(value, target.kind === 'dynamic' ? 'assign:dynamic' : `assign:${representationKey(target)}`, targets)
  }
  if (source !== undefined && host.member === 'getOwnPropertyDescriptor') {
    const into = descriptorValueOf(deriver, result)
    const key = operation.arguments[1] && definitionOf(operation.arguments[1].value)
    const text = key?.kind === 'constant' && (key.literal === 'string' || key.literal === 'number') ? key.text : null
    if (into)
      for (const value of leavesOf(source))
        if (value.kind === 'array-object' && (text === null || canonicalIndexLiteral(text) !== null))
          admit(value, 'array-undefined', [into], undefinedValue)
  }
  return { member: host.member, routes }
}

/** The operation and census reconstruct the routes independently of the published fact. */
export const hostObjectWalkPlanMatches = (
  operation: CallOperation,
  actual: HostObjectWalkPlan | undefined,
  definitionOf: (value: IrValueId) => IrOperation | null,
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  census: Pick<ConversionCensus, 'nodeFor' | 'nodeById'>,
  aliases?: ReadonlyMap<DeclarationId, HostMethodAlias>
): boolean => {
  const expected = hostObjectWalkPlanOf(operation, definitionOf, deriver, classes, census, aliases)
  if (expected === undefined) return actual === undefined
  return (
    actual !== undefined &&
    actual.member === expected.member &&
    actual.routes.size === expected.routes.size &&
    [...expected.routes].every(([key, leaves]) => {
      const cited = actual.routes.get(key)
      return (
        cited !== undefined &&
        cited.size === leaves.size &&
        [...leaves].every(([pair, node]) => cited.get(pair) === node && census.nodeById(node.id) === node)
      )
    })
  )
}
