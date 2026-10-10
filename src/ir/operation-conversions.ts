import type { ConversionNode, ConversionNodeId } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { nativeBufferMethodDescriptorOf } from '../conversion/native-buffer-method.js'
import type { DeclarationId, FunctionId, IrValueId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { abiOfCallee, constructAbiOfCallee } from '../projection/callee.js'
import { nativeExpandoSidecarOf } from '../projection/native-expando.js'
import { regexpDynamicSetValueOf, regexpFieldStorageOf } from '../projection/regexp-fields.js'
import { canonicalIndexLiteral } from '../representation/array-index.js'
import { classMemberOf, declaredRecordFieldOf, recordFieldsOfShape, recordIndexesOfShape } from '../projection/fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { isNativeCallableCarrier } from '../representation/callable-object.js'
import {
  abiKey,
  carriesUndefined,
  recordIndexForKeyCarrier,
  representationKey,
  type CallableAbi,
  type RecordField,
  type Representation
} from '../representation/model.js'
import type { IrBody, IrOperation } from './model.js'
import { nativeMethodFrameInputsOf } from './native-method-frames.js'
import { dynamicConstructorConversionsOf } from './dynamic-constructor-conversions.js'
import { genericNativeLogicalReceiverOf, receivableArguments } from './call-entry.js'
import { nativeLogicalReceiverCallablePayloadsOf } from '../representation/native-logical-receiver.js'
import { disjointNativeRecordIndexOf, nativeRecordIndexReadCarrierOf } from './native-record-index.js'
import { promiseReactionConversionInputsOf } from './promise-reaction-conversions.js'
import { internalOperationConversionInputsOf } from './internal-operation-conversions.js'
import { hostPromiseConversionInputsOf } from './host-promise-conversions.js'
import { nativePrototypeCallClaimsOf } from './native-prototype-calls.js'
import { nativePrototypeConversionInputsOf } from './native-prototype-conversions.js'
import { virtualDispatchFor } from '../projection/dispatch.js'
import { hostTemplateConversionInputsOf } from './host-template-conversions.js'
import { nativeConstructorGetInputsOf } from './native-constructor-reads.js'
import type { HostSpellings } from '../targets/cpp/host/host-members.js'
import { propertyReadConversionInputsOf } from './property-read-conversions.js'
import { nativeCallableArgumentEntryOf, type NativeCallableEntryProof } from './native-callable-argument.js'
import { nativeDataPropertyOf } from '../representation/native-data-properties.js'
import { nativeReflectFieldTransportOf } from './native-reflect-field.js'
import type { HostMethodAlias } from './host-method-aliases.js'
import { nativeUnionMethodTargetMatches } from './native-union-method-targets.js'

export type OperationConversionRole =
  | 'field-read'
  | 'index-read'
  | 'dynamic-write'
  | 'descriptor'
  | 'update'
  | 'equality'
  | 'object-sidecar'
  | 'call-argument'
  | 'promise-reaction'
  | 'buffer-method-result'
  | 'method-frame'
  | 'call-result'
  | 'field-write'
  | 'host-promise-completion'
  | 'array-element'
  | 'iterator-value'
  | 'await-result'
  | 'yield-value'
  | 'compute-result'
  | 'construct-argument'
  | 'construct-result'
  | 'collection-seed'
  | 'prototype-argument'
  | 'prototype-result'
  | 'prototype-callback'
  | 'native-base-view'
  | 'logical-receiver'

/** A value produced inside an operation, rather than supplied as an operand. */
export interface OperationConversionInput {
  readonly role: OperationConversionRole
  readonly source: Representation
  readonly target: Representation
  readonly nativeCallableEntry?: NativeCallableEntryProof
}

export interface OperationConversion extends OperationConversionInput {
  readonly conversion: ConversionNodeId
}

const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }

const leavesOf = (value: Representation): readonly Representation[] =>
  value.kind === 'optional'
    ? [...leavesOf(value.payload), { kind: value.absence }]
    : value.kind === 'tagged-union'
      ? value.arms.flatMap((arm) => leavesOf(arm.value))
      : [value]

const fieldsOf = (value: Representation, deriver: RepresentationDeriver): readonly RecordField[] => {
  if (value.kind === 'record' || value.kind === 'record-with-index') return value.fields
  if (value.kind === 'class-ref' || (value.kind === 'native-record-ref' && value.native === null))
    return recordFieldsOfShape(deriver, value.shapeId) ?? []
  return []
}

const indexedValueOf = (
  value: Representation,
  key: Representation,
  keyText: string | null,
  deriver: RepresentationDeriver
): Representation | null => {
  const indexes =
    value.kind === 'record-with-index'
      ? value.indexes
      : value.kind === 'native-record-ref' && value.native === null
        ? recordIndexesOfShape(deriver, value.shapeId)
        : []
  return recordIndexForKeyCarrier(indexes, key, keyText ?? undefined)?.value ?? null
}

const callableIdentityComparison = (value: Representation): boolean =>
  isNativeCallableCarrier(value.kind) || value.kind === 'callable-identity'

const dynamicCallee = (representation: Representation): boolean =>
  representation.kind === 'optional'
    ? dynamicCallee(representation.payload)
    : representation.kind === 'borrowed-ref'
      ? dynamicCallee(representation.referent)
      : representation.kind === 'dynamic'

/**
 * Publish the internal value adaptations an operation actually requires.
 * The pair comes from native storage and the operation's published result;
 * conversion admission remains the census's decision.
 */
export const operationConversionInputsOf = (
  operation: IrOperation,
  keyText: string | null,
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  hostArgumentsDynamic = false,
  abis?: ReadonlyMap<FunctionId, CallableAbi>,
  definitionOf?: (value: IrValueId) => IrOperation | null,
  body?: IrBody,
  virtualFrames?: ReadonlyMap<string, CallableAbi>,
  hosts?: Pick<HostSpellings, 'members'>,
  wellKnownSymbols?: ReadonlyMap<DeclarationId, string>,
  hostMethodAliases?: ReadonlyMap<DeclarationId, HostMethodAlias>
): readonly OperationConversionInput[] => {
  const inputs = new Map<string, OperationConversionInput>()
  const add = (role: OperationConversionRole, source: Representation, target: Representation): void => {
    if (
      operation.kind === 'get' &&
      (operation.nativeFieldViewRead !== undefined ||
        operation.nativeObjectDataSlot !== undefined ||
        operation.nativeDocumentEntry !== undefined) &&
      role === 'field-read'
    )
      return
    if (
      operation.kind === 'set' &&
      (operation.nativeFieldViewWrite !== undefined ||
        operation.nativeObjectDataSlot !== undefined ||
        operation.nativeDocumentEntry !== undefined) &&
      role === 'field-write'
    )
      return
    if (representationKey(source) === representationKey(target)) return
    const key = `${role}:${representationKey(source)}->${representationKey(target)}`
    if (role === 'prototype-argument' && operation.kind === 'call' && definitionOf && abis) {
      const sources = operation.arguments.flatMap((argument, ordinal) => (argument.representation === source ? [ordinal] : []))
      if (sources.length > 0) {
        for (const ordinal of sources) {
          const proof = nativeCallableArgumentEntryOf(operation, ordinal, target, definitionOf, abis)
          inputs.set(`${key}:argument:${ordinal}`, { role, source, target, ...(proof ? { nativeCallableEntry: proof } : {}) })
        }
        return
      }
    }
    inputs.set(key, { role, source, target })
  }
  if (operation.kind === 'call' || operation.kind === 'bind-callable') {
    const logical = genericNativeLogicalReceiverOf(operation)
    if (logical)
      for (const source of nativeLogicalReceiverCallablePayloadsOf(logical.representation)) add('logical-receiver', source, dynamic)
    // A dynamic callee's frame transports the physical receiver operand
    // itself through the same erased receiver channel (`C[k]()` on a class
    // constructor), so its callable payloads need the same materializer.
    if (operation.kind === 'call' && operation.receiver && dynamicCallee(operation.callee.representation))
      for (const source of nativeLogicalReceiverCallablePayloadsOf(operation.receiver.representation))
        add('logical-receiver', source, dynamic)
  }
  if (operation.kind === 'compute') {
    if (operation.form === 'update') {
      const value = operation.operands[0]
      if (value) add('update', value.representation, operation.result.representation)
    }
    if ((operation.operator === '===' || operation.operator === '!==') && !operation.nativeEquality) {
      const left = operation.operands[0]
      const right = operation.operands[1]
      if (left && right) {
        const directDynamic = left.representation.kind === 'dynamic' || right.representation.kind === 'dynamic'
        const leftValues = directDynamic ? [left.representation] : leavesOf(left.representation)
        const rightValues = directDynamic ? [right.representation] : leavesOf(right.representation)
        for (const first of leftValues)
          for (const second of rightValues) {
            if (first.kind === 'dynamic' && second.kind !== 'dynamic' && !callableIdentityComparison(second)) add('equality', second, first)
            if (second.kind === 'dynamic' && first.kind !== 'dynamic' && !callableIdentityComparison(first)) add('equality', first, second)
          }
      }
    }
    if (
      deriver.dynamicFallback &&
      operation.operator === '+' &&
      operation.operands.some((operand) => operand.representation.kind === 'tagged-union')
    )
      for (const operand of operation.operands) add('dynamic-write', operand.representation, dynamic)
  }
  if (operation.kind === 'get') {
    for (const conversion of propertyReadConversionInputsOf(operation, keyText, deriver, classes, abis, virtualFrames, wellKnownSymbols))
      add(conversion.role, conversion.source, conversion.target)
    if (abis)
      for (const conversion of nativeConstructorGetInputsOf(operation, keyText, classes, abis))
        add(conversion.role, conversion.source, conversion.target)
    if (abis !== undefined)
      for (const frame of nativeMethodFrameInputsOf(operation, keyText, classes, abis, body, definitionOf))
        add('method-frame', frame.source, frame.target)
    const result = operation.result.representation
    const present = result.kind === 'optional' ? result.payload : result
    if (keyText === 'constructor')
      for (const receiver of leavesOf(operation.receiver.representation))
        for (const conversion of dynamicConstructorConversionsOf(receiver, result, classes))
          add(conversion.role, conversion.source, conversion.target)
    for (const receiver of leavesOf(operation.receiver.representation)) {
      const nativeProperty = keyText === null ? null : nativeDataPropertyOf(receiver, keyText, wellKnownSymbols)
      if (nativeProperty) add('field-read', nativeProperty.result, result)
      const bufferMethod = keyText === null ? null : nativeBufferMethodDescriptorOf(receiver, keyText, result)
      if (bufferMethod) add('buffer-method-result', bufferMethod.physicalResult, bufferMethod.abi.result)
      const native = keyText === null ? null : regexpFieldStorageOf(receiver, keyText)
      const field = keyText === null || native ? null : declaredRecordFieldOf(deriver, receiver, keyText, classes)
      if (native) add('field-read', native, result)
      else if (field) add('field-read', field.value, result)
      if (receiver.kind === 'dynamic') add('field-read', receiver, result)
      if (receiver.kind === 'dictionary') {
        add('index-read', receiver.value, present)
        if (operation.receiver.representation.kind !== 'tagged-union') add('index-read', receiver.value, result)
      }
      if (receiver.kind === 'array-object' && (keyText === null || canonicalIndexLiteral(keyText) !== null)) {
        add('index-read', receiver.element, present)
        // A hole or out-of-range index reads as the result's own `undefined`
        // (`absentCapableElementText`), which a union spells as an arm.
        if (result.kind === 'tagged-union' && carriesUndefined(result)) add('index-read', { kind: 'undefined' }, result)
      }
      if (keyText === null || (!native && !field)) {
        const indexed = indexedValueOf(receiver, operation.key.representation, keyText, deriver)
        if (indexed) {
          add('index-read', indexed, present)
          if (receiver.kind === 'record-with-index' || (receiver.kind === 'native-record-ref' && receiver.native === null)) {
            add('index-read', nativeRecordIndexReadCarrierOf({ value: indexed }, result), result)
            if (
              keyText === null &&
              fieldsOf(receiver, deriver).length > 0 &&
              disjointNativeRecordIndexOf(deriver, receiver, operation.key.representation) === null
            )
              add('field-read', dynamic, result)
          }
        }
      }
    }
  }
  if (
    (operation.kind === 'set' || operation.kind === 'define-own-property') &&
    !(operation.kind === 'set' && operation.nativeCallableReadonlySet !== undefined)
  ) {
    for (const receiver of leavesOf(operation.receiver.representation)) {
      const regexpValue = operation.kind === 'set' ? regexpDynamicSetValueOf(receiver, keyText) : null
      if (regexpValue) add('dynamic-write', operation.value.representation, regexpValue)
      const declared = keyText === null || regexpValue ? null : declaredRecordFieldOf(deriver, receiver, keyText, classes)
      const accessor =
        receiver.kind === 'class-ref' && keyText !== null && classMemberOf(classes, receiver.declaration, keyText)?.kind === 'accessor'
      const indexed = indexedValueOf(receiver, operation.key.representation, keyText, deriver)
      const numericIndex =
        (receiver.kind === 'array-object' || receiver.kind === 'typed-array') &&
        (keyText === null
          ? operation.key.representation.kind === 'scalar' && operation.key.representation.domain === 'number'
          : canonicalIndexLiteral(keyText) !== null)
      if (declared) add('field-write', operation.value.representation, declared.value)
      if (keyText === null)
        for (const key of (operation.kind === 'set' ? operation.provenKeyTexts : undefined) ?? []) {
          const field = declaredRecordFieldOf(deriver, receiver, key, classes)
          if (field) add('field-write', operation.value.representation, field.value)
        }
      if (indexed && !declared) add('field-write', operation.value.representation, indexed)
      if (receiver.kind === 'dictionary') add('field-write', operation.value.representation, receiver.value)
      if (receiver.kind === 'array-object' && (keyText === null || canonicalIndexLiteral(keyText) !== null))
        add('field-write', operation.value.representation, receiver.element)
      if (accessor && abis && receiver.kind === 'class-ref' && keyText !== null) {
        const member = classMemberOf(classes, receiver.declaration, keyText)
        const setter = member?.kind === 'accessor' ? member.accessor.setter : null
        const slot = setter ? abis.get(setter)?.parameters[0]?.value : null
        if (slot) add('field-write', operation.value.representation, slot)
      }
      if (
        receiver.kind === 'dynamic' ||
        receiver.kind === 'native-handle' ||
        isNativeCallableCarrier(receiver.kind) ||
        (nativeExpandoSidecarOf(receiver) && !declared && !accessor && !indexed && !numericIndex)
      )
        add('dynamic-write', operation.value.representation, dynamic)
      if (
        operation.kind === 'define-own-property' &&
        !declared &&
        indexed &&
        disjointNativeRecordIndexOf(deriver, receiver, operation.key.representation, keyText ?? undefined) === null
      )
        add('descriptor', indexed, dynamic)
    }
  }
  if (operation.kind === 'allocate-record' && operation.result.representation.kind === 'dynamic')
    for (const field of operation.fields) add('dynamic-write', field.value.representation, dynamic)
  if (operation.kind === 'allocate-array-object' && operation.result.representation.kind === 'dynamic')
    for (const element of operation.elements) if (element.kind === 'element') add('dynamic-write', element.value.representation, dynamic)
  if (operation.kind === 'call') {
    const read = definitionOf?.(operation.callee.value)
    const hostAlias = read?.kind === 'binding-read' ? hostMethodAliases?.get(read.declaration) : undefined
    const prototypeClaims = definitionOf ? nativePrototypeCallClaimsOf(operation, definitionOf, classes, deriver) : null
    if (prototypeClaims)
      for (const conversion of nativePrototypeConversionInputsOf(operation, prototypeClaims))
        add(conversion.role, conversion.source, conversion.target)
    if (definitionOf)
      for (const conversion of hostTemplateConversionInputsOf(operation, definitionOf, deriver, classes, hosts, hostMethodAliases))
        add(conversion.role, conversion.source, conversion.target)
    if (definitionOf)
      for (const conversion of promiseReactionConversionInputsOf(operation, definitionOf, classes))
        add(conversion.role, conversion.source, conversion.target)
    if (definitionOf)
      for (const conversion of hostPromiseConversionInputsOf(operation, definitionOf))
        add(conversion.role, conversion.source, conversion.target)
    if (
      operation.callee.representation.kind === 'dynamic' &&
      prototypeClaims === null &&
      operation.hostTemplate === undefined &&
      operation.intrinsicOwnKeys === undefined &&
      operation.intrinsicReflection === undefined &&
      hostAlias === undefined
    ) {
      if (operation.receiver) add('dynamic-write', operation.receiver.representation, dynamic)
      for (const argument of operation.arguments) add('dynamic-write', argument.representation, dynamic)
      if (operation.result && operation.result.representation.kind !== 'void')
        add('call-result', operation.callee.representation, operation.result.representation)
    }
    if (operation.intrinsicReflection === 'set') {
      const value = operation.arguments[2]
      const receiver = operation.arguments[0]?.representation
      const key = operation.arguments[1]
      const definition = key ? definitionOf?.(key.value) : null
      const keyText = definition?.kind === 'constant' && definition.literal === 'string' ? definition.text : null
      const generated =
        receiver &&
        'ownership' in receiver &&
        receiver.ownership === 'shared-refcount' &&
        (receiver.kind === 'record' ||
          receiver.kind === 'record-with-index' ||
          receiver.kind === 'class-ref' ||
          receiver.kind === 'array-object' ||
          (receiver.kind === 'native-record-ref' && receiver.native === null))
      const field = generated && keyText !== null ? declaredRecordFieldOf(deriver, receiver, keyText, classes) : null
      if (value && nativeReflectFieldTransportOf(operation, field) !== 'native-write') add('dynamic-write', value.representation, dynamic)
    }
    if (hostArgumentsDynamic) {
      const abi = abiOfCallee(operation.callee.representation)
      if (abi) for (const argument of receivableArguments(abi, operation.arguments)) add('dynamic-write', argument.representation, dynamic)
    }
    const frames = new Map<string, { readonly abi: CallableAbi; readonly receiver: Representation | null }>()
    const frame = (abi: CallableAbi | null | undefined, receiver = operation.receiver?.representation ?? null): void => {
      if (abi) frames.set(`${abiKey(abi)}:${receiver === null ? '' : representationKey(receiver)}`, { abi, receiver })
    }
    if (operation.target?.kind === 'virtual' && virtualFrames)
      frame(
        virtualDispatchFor(
          virtualFrames,
          operation.target.owner,
          operation.target.key,
          operation.target.role,
          abiOfCallee(operation.callee.representation),
          (abi) => abi
        )?.entry
      )
    if (operation.target?.kind === 'direct' && abis?.has(operation.target.functionId)) frame(abis.get(operation.target.functionId))
    else if (operation.target?.kind === 'union-arm' && abis) {
      // The selected Function and receiver share one tag path. A physical
      // upcast on Call.receiver can already have erased that tag; the Get's
      // snapshot is the source the native arm dispatch actually consumes.
      const authentic = definitionOf !== undefined && nativeUnionMethodTargetMatches(operation, classes, definitionOf)
      for (const arm of operation.target.arms) {
        let receiver = authentic && read?.kind === 'get' ? read.receiver.representation : null
        for (const index of arm.path) receiver = receiver?.kind === 'tagged-union' ? (receiver.arms[index]?.value ?? null) : null
        frame(
          abis.get(arm.functionId),
          receiver?.kind === 'class-ref' && receiver.declaration === arm.declaration
            ? receiver
            : (operation.receiver?.representation ?? null)
        )
      }
    } else if (operation.family && abis) for (const member of operation.family) frame(abis.get(member.functionId))
    else {
      for (const callee of leavesOf(operation.callee.representation)) frame(abiOfCallee(callee))
      frame(operation.closedFrame?.abi)
      frame(operation.closedCallee?.nativeEntryAbi)
    }
    const nativeHostMethod =
      (read?.kind === 'get' && (read.hostMethod !== undefined || read.receiver.representation.kind === 'native-handle')) ||
      hostAlias !== undefined
    if (
      operation.hostTemplate === undefined &&
      operation.intrinsicOwnKeys === undefined &&
      operation.intrinsicReflection === undefined &&
      prototypeClaims === null &&
      !nativeHostMethod &&
      !hostArgumentsDynamic &&
      !operation.argumentsAreSpread
    )
      for (const { abi, receiver } of frames.values()) {
        if (receiver && abi.receiver) {
          add('call-argument', receiver, abi.receiver)
          if (receiver.kind === 'tagged-union')
            for (const arm of receiver.arms)
              if (arm.value.kind === 'class-ref' && !absentArmOfMethodRead(operation, arm.value, abi.receiver))
                add('call-argument', arm.value, abi.receiver)
        }
        for (const [position, argument] of receivableArguments(abi, operation.arguments).entries()) {
          const target = abi.restFrom !== null && position >= abi.restFrom ? null : abi.parameters[position]?.value
          if (target) add('call-argument', argument.representation, target)
        }
        if (operation.result && operation.result.representation.kind !== 'void')
          add('call-result', abi.result.kind === 'void' ? { kind: 'undefined' } : abi.result, operation.result.representation)
      }
  }
  if (operation.kind === 'construct') {
    const frames =
      operation.entry?.kind === 'explicit-object-return'
        ? [operation.entry.abi]
        : leavesOf(operation.callee.representation).flatMap((callee) => constructAbiOfCallee(callee) ?? [])
    for (const abi of frames) {
      for (const [position, argument] of receivableArguments(abi, operation.arguments).entries()) {
        const target = abi.restFrom !== null && position >= abi.restFrom ? null : abi.parameters[position]?.value
        if (target) add('construct-argument', argument.representation, target)
      }
      add('construct-result', abi.result, operation.result.representation)
    }
    const target = operation.result.representation
    if (target.kind === 'keyed-collection' && (target.family === 'map' || target.family === 'set')) {
      const seed = (source: Representation): void => {
        if (source.kind === 'optional') return seed(source.payload)
        if (source.kind === 'tagged-union') {
          for (const arm of source.arms) seed(arm.value)
          return
        }
        if (target.family === 'set') {
          if (source.kind === 'array-object' || source.kind === 'iterator') add('collection-seed', source.element, target.key)
          else if (source.kind === 'keyed-collection' && source.family === 'set') add('collection-seed', source.key, target.key)
        } else if (target.value !== null) {
          if (source.kind === 'keyed-collection' && source.family === 'map' && source.value !== null) {
            add('collection-seed', source.key, target.key)
            add('collection-seed', source.value, target.value)
          } else if (source.kind === 'array-object' && source.element.kind === 'record') {
            const [key, value] = source.element.fields
            if (source.element.fields.length === 2 && key?.key === '0' && value?.key === '1' && key.required && value.required) {
              add('collection-seed', key.value, target.key)
              add('collection-seed', value.value, target.value)
            }
          }
        }
      }
      const source = operation.arguments[0]?.representation
      if (source) seed(source)
    }
  }
  if (
    operation.kind === 'construct' &&
    (operation.callee.representation.kind === 'dynamic' ||
      (operation.callee.representation.kind === 'native-handle' && operation.callee.representation.protocol === 'ProxyConstructor'))
  )
    for (const argument of operation.arguments) add('dynamic-write', argument.representation, dynamic)
  if (
    operation.kind === 'bind-callable' &&
    ((operation.unboxedMethod !== undefined && operation.unboxedMethodConfirmed !== true) || operation.builtinShadowGuard === 'bind')
  ) {
    const receiver = operation.thisArgument ?? operation.receiver
    if (receiver) add('dynamic-write', receiver.representation, dynamic)
    add('dynamic-write', operation.source.representation, dynamic)
    for (const argument of operation.bound) add('dynamic-write', argument.representation, dynamic)
    add('call-result', dynamic, operation.result.representation)
  }
  if (operation.kind === 'bind-callable') {
    if (operation.sourceAbi.receiver && operation.receiver)
      add('call-argument', operation.receiver.representation, operation.sourceAbi.receiver)
    for (const [position, argument] of operation.bound.entries()) {
      const slot = operation.sourceAbi.parameters[position]?.value
      if (slot) add('call-argument', argument.representation, slot)
    }
  }
  if (operation.kind === 'call' && operation.hostTemplate === 'object-assign') {
    const target = operation.arguments[0]?.representation
    if (target) {
      for (const targetArm of leavesOf(target)) {
        if (!nativeExpandoSidecarOf(targetArm)) continue
        for (const argument of operation.arguments.slice(1))
          for (const source of leavesOf(argument.representation))
            for (const field of fieldsOf(source, deriver))
              if (!declaredRecordFieldOf(deriver, targetArm, field.key, classes)) add('object-sidecar', field.value, dynamic)
      }
    }
  }
  for (const conversion of internalOperationConversionInputsOf(operation, deriver, abis, body, definitionOf))
    add(conversion.role, conversion.source, conversion.target)
  return [...inputs.values()]
}

/**
 * A receiver arm that cannot have supplied the method a possibly-absent callee
 * holds. `value.toJSON(meta)` over `Color | Texture | Float32Array` reads
 * Texture's method on the Texture arm and `undefined` everywhere else, so the
 * callee is `optional(<Texture.toJSON>)` and the call converts its receiver to
 * Texture only once the callee is present. A class arm neither derived from
 * nor a base of the method's receiver class could only have produced a method
 * with its own receiver convention -- a different carrier than this one -- so
 * on that arm the call throws before any receiver conversion runs.
 */
const absentArmOfMethodRead = (operation: IrOperation, arm: Representation, declared: Representation): boolean =>
  operation.kind === 'call' &&
  operation.callee.representation.kind === 'optional' &&
  arm.kind === 'class-ref' &&
  declared.kind === 'class-ref' &&
  arm.declaration !== declared.declaration &&
  !arm.ancestors.includes(declared.declaration) &&
  !declared.ancestors.includes(arm.declaration)

const conversionNodeOf = (
  input: OperationConversionInput,
  conversions: Pick<
    ConversionCensus,
    'nodeFor' | 'fieldReadFor' | 'absentIndexReadFor' | 'callArgumentFor' | 'nativeBaseViewFor' | 'nativeMethodFor'
  >
): ConversionNode =>
  input.nativeCallableEntry
    ? (conversions.nativeMethodFor(input.source, input.target) ?? conversions.nodeFor(input.source, input.target))
    : input.role === 'native-base-view'
      ? (conversions.nativeBaseViewFor(input.source, input.target) ?? conversions.nodeFor(input.source, input.target))
      : input.role === 'field-read'
        ? conversions.fieldReadFor(input.source, input.target)
        : input.role === 'index-read'
          ? conversions.absentIndexReadFor(input.source, input.target)
          : input.role === 'call-argument' || input.role === 'construct-argument'
            ? conversions.callArgumentFor(input.source, input.target)
            : conversions.nodeFor(input.source, input.target)

export const operationConversionsOf = (
  inputs: readonly OperationConversionInput[],
  conversions: Pick<
    ConversionCensus,
    'nodeFor' | 'fieldReadFor' | 'absentIndexReadFor' | 'callArgumentFor' | 'nativeBaseViewFor' | 'nativeMethodFor'
  >
): readonly OperationConversion[] => inputs.map((input) => ({ ...input, conversion: conversionNodeOf(input, conversions).id }))

export const operationConversionsMatch = (
  expected: readonly OperationConversionInput[],
  actual: readonly OperationConversion[],
  conversions: Pick<
    ConversionCensus,
    'nodeById' | 'nodeFor' | 'fieldReadFor' | 'absentIndexReadFor' | 'callArgumentFor' | 'nativeBaseViewFor' | 'nativeMethodFor'
  >
): boolean =>
  expected.length === actual.length &&
  expected.every((input, index) => {
    const value = actual[index]!
    const node = conversions.nodeById(value.conversion)
    return (
      input.role === value.role &&
      (input.nativeCallableEntry === undefined
        ? value.nativeCallableEntry === undefined
        : value.nativeCallableEntry?.ordinal === input.nativeCallableEntry.ordinal &&
          value.nativeCallableEntry.callables.length === input.nativeCallableEntry.callables.length &&
          value.nativeCallableEntry.callables.every((callable, index) => callable === input.nativeCallableEntry!.callables[index])) &&
      representationKey(input.source) === representationKey(value.source) &&
      representationKey(input.target) === representationKey(value.target) &&
      conversionNodeOf(input, conversions) === node &&
      node !== null &&
      representationKey(node.source) === representationKey(input.source) &&
      representationKey(node.target) === representationKey(input.target)
    )
  })
