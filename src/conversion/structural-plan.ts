import { conversionRequiresSourceGuard, type ConversionNode, type ConversionNodeResolver } from './algebra.js'
import { abiOfCallee } from '../projection/callee.js'
import type { RecordLayoutPolicy } from '../representation/policies.js'
import { carriesUndefined, containsUnresolved, representationKey, type RecordField, type Representation } from '../representation/model.js'
import { containsOpenDocument } from './document-record-view.js'
import type { DeclarationId } from '../identity/ids.js'
import { optionalMethodPayloadOf, structuralRecordViewPlan, type FamilyMemberKeys, type RecordViewPlan } from './record-view.js'
import { recipeIsMaterializableWithoutPriorSourceGuard } from './recipe-closure.js'
import { nativeFieldViewPlanOf, type NativeFieldViewPlan } from './native-field-view.js'
import { nativeLogicalReceiverRecipeOf, type NativeLogicalReceiverRecipe } from './native-logical-receiver.js'

export type AcceptedConversion = (source: Representation, target: Representation) => ConversionNode | null

export interface CertifiedRecordViewPlan {
  readonly source: Representation
  readonly target: Representation
  readonly view: RecordViewPlan
  readonly leaves: ReadonlyMap<string, ConversionNode>
  readonly methods: readonly StructuralMethodRecipe[]
  readonly fieldViews?: ReadonlyMap<RecordViewPlan, NativeFieldViewPlan>
}

export interface StructuralMethodRecipe {
  readonly declaration: DeclarationId
  readonly key: string
  readonly source: Extract<Representation, { kind: 'function-value-dispatch' }>
  readonly target: Representation
  readonly method: ConversionNode
  readonly adaptation: ConversionNode
}

export interface RecordToArrayPlan {
  readonly source: Extract<Representation, { kind: 'record' }>
  readonly target: Extract<Representation, { kind: 'array-object' }>
  readonly fields: readonly { readonly field: RecordField; readonly conversion: ConversionNode }[]
}

export interface CallableViewPlan {
  readonly source: Representation
  readonly target: Representation
  readonly receiver: ConversionNode | null
  readonly logicalReceiver?: NativeLogicalReceiverRecipe
  readonly parameters: readonly ConversionNode[]
  readonly omittedArguments?: readonly ConversionNode[]
  readonly result: ConversionNode | null
  readonly restPacking?: {
    readonly from: number
    readonly array: Extract<Representation, { kind: 'array-object' }>
    readonly elements: readonly ConversionNode[]
  }
  readonly restUnpacking?: {
    readonly from: number
    readonly offset?: number
    readonly slot: Extract<Representation, { kind: 'array-object' | 'record' }>
    readonly elements: readonly {
      readonly field: RecordField | null
      readonly present: ConversionNode
      readonly absent: ConversionNode | null
    }[]
  }
}

export interface CallablePayloadPlan {
  readonly source: Representation
  readonly target: Representation
  readonly mode: 'wrap' | 'map' | 'unwrap'
  readonly payload: ConversionNode
}

const callablePayloadPairOf = (source: Representation, target: Representation): readonly [Representation, Representation] | null => {
  if (source.kind !== 'optional' && target.kind !== 'optional') return null
  const from = source.kind === 'optional' ? source.payload : source
  const to = target.kind === 'optional' ? target.payload : target
  return abiOfCallee(from) !== null && abiOfCallee(to) !== null && representationKey(from) !== representationKey(to) ? [from, to] : null
}

/** Optional transport cannot hide an unsealed future callable frame. */
export const callablePayloadPlan = (
  source: Representation,
  target: Representation,
  accepted: AcceptedConversion,
  resolve?: ConversionNodeResolver
): CallablePayloadPlan | null => {
  const pair = callablePayloadPairOf(source, target)
  if (pair === null || (source.kind === 'optional' && target.kind === 'optional' && source.absence !== target.absence)) return null
  const payload = accepted(pair[0], pair[1])
  if (payload === null || !recipeIsMaterializableWithoutPriorSourceGuard(payload, resolve)) return null
  return { source, target, mode: source.kind !== 'optional' ? 'wrap' : target.kind === 'optional' ? 'map' : 'unwrap', payload }
}

export const structuralConversionKey = (source: Representation, target: Representation): string =>
  `${representationKey(source)}->${representationKey(target)}`

const dynamicSidecar: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }

const structuralMaterializers = new Set([
  'view:structural-record',
  'view:family-member-record',
  'view:adapted-callable',
  'gea::record::classStructuralView',
  'gea::record::recast',
  'gea::record::recastWithIndex',
  'gea::record::recastWithExpando',
  'gea::record::emptyNative',
  'gea::record::ownedArm',
  'gea::Optional::recastPayload',
  'gea::Optional::recastPayloadArm',
  'gea::Optional::converting-ctor',
  'gea::TaggedUnion::ofArm',
  'chain:record-recast',
  'chain:optional-record-recast',
  'chain:union-recast',
  'chain:optional-wrap-converted',
  'chain:optional-payload-convert'
])

const hasReferenceRecordTarget = (value: Representation): boolean =>
  value.kind === 'native-record-ref'
    ? value.native === null
    : value.kind === 'record'
      ? value.ownership === 'shared-refcount'
      : value.kind === 'optional'
        ? hasReferenceRecordTarget(value.payload)
        : value.kind === 'tagged-union'
          ? value.arms.some((arm) => hasReferenceRecordTarget(arm.value))
          : false

const hasRecordViewSource = (value: Representation): boolean =>
  value.kind === 'record' ||
  value.kind === 'record-with-index' ||
  value.kind === 'class-ref' ||
  (value.kind === 'native-record-ref' && value.native === null) ||
  (value.kind === 'optional' && hasRecordViewSource(value.payload)) ||
  (value.kind === 'tagged-union' && value.arms.some((arm) => hasRecordViewSource(arm.value)))

/** Layout-dependent atoms need the same selected structural proof as an explicit record-view node. */
export const structuralRecipeRequiredFor = (node: ConversionNode): boolean => {
  const capability = node.capability
  if (capability.kind !== 'atom' && capability.kind !== 'static') return false
  const materializer = capability.materializer
  const id = materializer.id
  if (callablePayloadPairOf(node.source, node.target) !== null) return materializer.callablePayload === undefined
  if (id === 'gea::Iterator::objectView') return materializer.iteratorObjectView === undefined
  if (id === 'gea::Iterator::protocol') return materializer.protocolIterator === undefined
  if (id === 'gea::Iterable::objectView') return materializer.iterableObjectView === undefined
  if (id === 'gea::CallableObject::result-adapter' || id === 'chain:result-adapted-callable') return materializer.callableView === undefined
  // The registry composes this contract from its selected native leaf transports.
  // A checked subset selection can discard alternatives while preserving every
  // live payload; it needs tag/presence selection, never a rebuilt record layout.
  const transportsPayload = materializer.nativeFieldProtocol === 'unused' && materializer.nativePayloadTransport === 'preserved'
  if (!transportsPayload && containsOpenDocument(node.source) && hasReferenceRecordTarget(node.target))
    return materializer.documentRecordView === undefined
  return (
    structuralMaterializers.has(id) &&
    (id.startsWith('view:') ||
      id === 'gea::record::classStructuralView' ||
      (!transportsPayload &&
        hasReferenceRecordTarget(node.target) &&
        hasRecordViewSource(node.source) &&
        !recordArmsCarriedExactly(node.source, node.target)))
  )
}

const unionLeavesOf = (value: Representation): readonly Representation[] =>
  value.kind === 'tagged-union' ? value.arms.flatMap((arm) => unionLeavesOf(arm.value)) : [value]

/** A sum re-tagged into another sum whose every record-bearing leaf lands on
 * the identical carrier needs no layout: it only re-homes arms, which the
 * selected `ofArm` (a narrowing's or widening's) already does. Requiring a
 * structural plan there asked the record-view planner to re-derive a
 * flow-proved narrowing of the non-record arms, which it cannot see. */
const recordArmsCarriedExactly = (source: Representation, target: Representation): boolean => {
  if (source.kind !== 'tagged-union' || target.kind !== 'tagged-union') return false
  const carried = new Set(unionLeavesOf(target).map(representationKey))
  return unionLeavesOf(source).every((leaf) => !hasRecordViewSource(leaf) || carried.has(representationKey(leaf)))
}

/** A value read as `undefined`/`null`/`void` is DISCARDED (`chain:unreachable-value`,
 * `chain:discard-into-void`): correct only where flow already proved the read
 * yields the absence, never as the home of a live union arm. Offered as one, a
 * recast took the first target arm (`undefined`) for every `number | string |
 * ...` arm and printed `undefined` for each (`typeof-runtime-string.ts`). */
const discardsIntoAbsence = (from: Representation, into: Representation): boolean =>
  (into.kind === 'undefined' || into.kind === 'null' || into.kind === 'void') && from.kind !== into.kind

/** The selected view's leaf obligations, rather than the candidates its planner considered. */
export const certifiedRecordViewPlan = (
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: Representation,
  accepted: AcceptedConversion,
  members?: FamilyMemberKeys,
  nativeMethod?: AcceptedConversion,
  resolve?: ConversionNodeResolver
): CertifiedRecordViewPlan | null => {
  const view = structuralRecordViewPlan(
    layouts,
    source,
    target,
    (from, into, role) => {
      const node = role === 'field-read' ? (nativeMethod?.(from, into) ?? accepted(from, into)) : accepted(from, into)
      return (
        node !== null &&
        node.capability.kind !== 'never' &&
        (role !== 'sum-home' || (!conversionRequiresSourceGuard(node.capability, resolve) && !discardsIntoAbsence(from, into)))
      )
    },
    members
  )
  if (view === null) return null
  const leaves = new Map<string, ConversionNode>()
  const methods: StructuralMethodRecipe[] = []
  const install = (from: Representation, into: Representation, node: ConversionNode | null): boolean => {
    const key = structuralConversionKey(from, into)
    if (node === null || node.capability.kind === 'never') return false
    if (representationKey(node.source) !== representationKey(from) || representationKey(node.target) !== representationKey(into))
      throw new Error(`structural conversion ${key} received proof for ${structuralConversionKey(node.source, node.target)}`)
    const existing = leaves.get(key)
    if (existing !== undefined) return existing === node
    leaves.set(key, node)
    return true
  }
  const add = (from: Representation, into: Representation): boolean => {
    if (leaves.has(structuralConversionKey(from, into))) return true
    return install(from, into, accepted(from, into))
  }
  // A property read preserves the selected Function and authenticates its
  // logical receiver at invocation. Its contextual native method contract
  // wins over ordinary physical-frame adaptation when that contract applies.
  // A refused frame dependency remains refused; it is not an ordinary fallback.
  const admittedMethodNode = (node: ConversionNode | null): ConversionNode | null => {
    return node !== null && recipeIsMaterializableWithoutPriorSourceGuard(node, resolve) ? node : null
  }
  const methodNode = (from: Representation, into: Representation): ConversionNode | null =>
    admittedMethodNode(nativeMethod?.(from, into) ?? accepted(from, into))
  const addMethod = (from: Representation, into: Representation): boolean => install(from, into, methodNode(from, into))
  const walk = (plan: RecordViewPlan): boolean => {
    switch (plan.kind) {
      case 'owned':
        return true
      case 'optional':
      case 'assert':
        return walk(plan.payload)
      case 'arm': {
        const arm = plan.target.arms[plan.index]
        return arm !== undefined && (plan.payload === null ? add(plan.source, arm.value) : walk(plan.payload))
      }
      case 'recast-union':
        return plan.arms.every((home, index) => {
          const from = plan.source.arms[index]
          const into = plan.target.arms[home.index]
          return (
            from !== undefined &&
            into !== undefined &&
            (home.via === 'exact' || (home.via === 'convert' ? add(from.value, into.value) : walk(home.via)))
          )
        })
      case 'dispatch': {
        const payload = plan.target.kind === 'optional' ? plan.target.payload : plan.target
        return plan.arms.every((home, index) => {
          const from = plan.source.arms[index]
          return (
            from !== undefined &&
            (home.via === 'exact' || home.via === 'absent' || (home.via === 'convert' ? add(from.value, payload) : walk(home.via)))
          )
        })
      }
      case 'iterator-result':
        return [plan.yieldHome, plan.returnHome].every((home) => {
          const arm = plan.target.arms[home.index]
          return arm !== undefined && (home.payload === null ? add(plan.source, arm.value) : walk(home.payload))
        })
      case 'fields':
        return (
          plan.fields.every(({ field, read }) => {
            switch (read.kind) {
              case 'absent':
                return true
              case 'native-descriptor':
                return nativeFieldViewPlanOf(plan, layouts) !== null
              case 'held':
                return abiOfCallee(read.held.value) !== null && abiOfCallee(field.value) !== null
                  ? addMethod(read.held.value, field.value)
                  : add(read.held.value, field.value)
              case 'view':
                return walk(read.plan)
              case 'sidecar':
                return (
                  add(dynamicSidecar, field.value) && (nativeFieldViewPlanOf(plan, layouts) === null || add(field.value, dynamicSidecar))
                )
              case 'class-accessor':
              case 'record-accessor':
                return abiOfCallee(read.value) !== null && abiOfCallee(field.value) !== null
                  ? addMethod(read.value, field.value)
                  : add(read.value, field.value)
              case 'method-value': {
                if (plan.source.kind !== 'class-ref') return false
                const own = layouts.classMethodAbiFor?.(plan.source.declaration, field.key)
                const member = optionalMethodPayloadOf(field.value)
                if (own === undefined || own === null) return false
                // The declared slot is dynamic: the method's own Function value crosses into it.
                if (member.kind === 'dynamic') return add({ kind: 'function-value-dispatch', abi: own }, member)
                if (member.kind !== 'function-value-dispatch') return false
                const sources = layouts.classMethodValueSourcesFor?.(plan.source.declaration, field.key, member)
                return (
                  sources !== null &&
                  sources !== undefined &&
                  sources.every((held) => addMethod(held, member)) &&
                  addMethod({ kind: 'function-value-dispatch', abi: own }, member)
                )
              }
              case 'bound-method': {
                if (plan.source.kind !== 'class-ref') return false
                const own = layouts.classMethodAbiFor?.(plan.source.declaration, field.key)
                const member = optionalMethodPayloadOf(field.value)
                if (own === undefined || own === null || !('abi' in member)) return false
                const source: Extract<Representation, { kind: 'function-value-dispatch' }> = { kind: 'function-value-dispatch', abi: own }
                const erased: Representation = { ...source, abi: { ...own, receiver: null } }
                const method = admittedMethodNode(nativeMethod?.(source, erased) ?? null)
                const adaptation = methodNode(erased, member)
                if (method === null || method.capability.kind === 'never' || adaptation === null || adaptation.capability.kind === 'never')
                  return false
                if (!install(source, erased, method) || !install(erased, member, adaptation)) return false
                const methodSources = layouts.classMethodValueSourcesFor?.(plan.source.declaration, field.key, source)
                if (methodSources === null || methodSources === undefined || !methodSources.every((held) => addMethod(held, source)))
                  return false
                methods.push({ declaration: plan.source.declaration, key: field.key, source, target: member, method, adaptation })
                return true
              }
            }
          }) &&
          (plan.spilled ?? []).every(({ held, index }) => add(held.value, index.value)) &&
          (plan.expandoSpilled ?? []).every((held) => add(held.value, dynamicSidecar))
        )
    }
  }
  if (!walk(view)) return null
  const fieldViews = new Map<RecordViewPlan, NativeFieldViewPlan>()
  const collect = (plan: RecordViewPlan): void => {
    switch (plan.kind) {
      case 'owned':
        return
      case 'optional':
      case 'assert':
        collect(plan.payload)
        return
      case 'arm':
        if (plan.payload) collect(plan.payload)
        return
      case 'dispatch':
      case 'recast-union':
        for (const arm of plan.arms) if (typeof arm.via === 'object') collect(arm.via)
        return
      case 'iterator-result':
        if (plan.yieldHome.payload) collect(plan.yieldHome.payload)
        if (plan.returnHome.payload) collect(plan.returnHome.payload)
        return
      case 'fields': {
        const fields = nativeFieldViewPlanOf(plan, layouts, (source, target) => leaves.get(structuralConversionKey(source, target)) ?? null)
        if (fields) fieldViews.set(plan, fields)
        for (const field of plan.fields) if (field.read.kind === 'view') collect(field.read.plan)
      }
    }
  }
  collect(view)
  return { source, target, view, leaves, methods, fieldViews }
}

/** Contiguous tuple storage is materialized once, with the exact admitted conversion of each element. */
export const recordToArrayPlan = (
  source: Extract<Representation, { kind: 'record' }>,
  target: Extract<Representation, { kind: 'array-object' }>,
  accepted: AcceptedConversion
): RecordToArrayPlan | null => {
  if (
    source.accessors.length !== 0 ||
    source.fields.length === 0 ||
    target.ownership !== 'shared-refcount' ||
    containsUnresolved(target.element) ||
    !source.fields.every((field, index) => field.key === String(index))
  )
    return null
  const fields: { field: RecordField; conversion: ConversionNode }[] = []
  for (const field of source.fields) {
    if (containsUnresolved(field.value)) return null
    const conversion = accepted(field.value, target.element)
    if (conversion === null || conversion.capability.kind === 'never') return null
    if (
      representationKey(conversion.source) !== representationKey(field.value) ||
      representationKey(conversion.target) !== representationKey(target.element)
    )
      throw new Error(`tuple field ${field.key} received a conversion for different carriers`)
    fields.push({ field, conversion })
  }
  return { source, target, fields }
}

/** A finite native frame whose fixed prefix and result enter exact approved transports. */
export const callableViewPlan = (
  source: Representation,
  target: Representation,
  accepted: AcceptedConversion,
  resolve?: ConversionNodeResolver,
  classDowncast?: AcceptedConversion
): CallableViewPlan | null => {
  const from = abiOfCallee(source)
  const to = abiOfCallee(target)
  if (from === null || to === null || (from.receiver !== null && to.receiver === null)) return null
  // A fixed or suffix-rest public frame has already erased whether omitted
  // named slots were supplied. It cannot reconstruct a source arguments count.
  if (
    from.argumentsFrame !== to.argumentsFrame &&
    !(from.restFrom === 0 && to.restFrom === 0) &&
    !(from.restFrom === null && to.argumentsFrame === 'actual')
  )
    return null
  const packsRest = from.restFrom !== null && to.restFrom === null
  const unpacksRest = from.restFrom === null && to.restFrom !== null
  const rest = packsRest ? from.parameters[from.restFrom!]?.value : null
  const publicRest = unpacksRest ? to.parameters[to.restFrom!]?.value : null
  if (packsRest) {
    if (
      from.parameters.length !== from.restFrom! + 1 ||
      rest?.kind !== 'array-object' ||
      rest.ownership !== 'shared-refcount' ||
      rest.recursive !== undefined ||
      rest.extension !== null
    )
      return null
  } else if (unpacksRest) {
    if (
      to.parameters.length !== to.restFrom! + 1 ||
      (publicRest?.kind !== 'array-object' && publicRest?.kind !== 'record') ||
      publicRest.ownership === 'borrowed' ||
      (publicRest.kind === 'array-object' && (publicRest.ownership !== 'shared-refcount' || publicRest.recursive !== undefined))
    )
      return null
  } else if (from.restFrom !== to.restFrom) return null
  // A class handle entering a DESCENDANT's slot inside the frame -- an
  // override's own-class parameter read through its base declaration
  // (`new this.constructor().copy( this )`, every `copy( source )`
  // override). The ordinary narrowing trusts an `instanceof`
  // guard the emitter rendered, and an adapter frame has none; the checked
  // downcast verifies the allocation's class chain and throws a TypeError on
  // a stranger, the same verdict a virtual dispatch's descendant argument
  // gets (`targets/cpp/virtual-methods.ts`'s `classRefConversionText`).
  const guarded = (from: Representation, into: Representation, downcast: boolean): ConversionNode | null => {
    const node = accepted(from, into)
    if (node !== null && recipeIsMaterializableWithoutPriorSourceGuard(node, resolve)) return node
    const checked = downcast ? (classDowncast?.(from, into) ?? null) : null
    return checked !== null && recipeIsMaterializableWithoutPriorSourceGuard(checked, resolve) ? checked : null
  }
  const leaf = (from: Representation, into: Representation, downcast = false): ConversionNode | null => {
    const node = guarded(from, into, downcast)
    if (node === null) return null
    if (representationKey(node.source) !== representationKey(from) || representationKey(node.target) !== representationKey(into))
      throw new Error(`callable conversion ${structuralConversionKey(from, into)} received proof for different carriers`)
    return node
  }
  const receiver = from.receiver === null || to.receiver === null ? null : leaf(to.receiver, from.receiver)
  const logicalReceiver =
    from.receiver === null && to.receiver !== null ? nativeLogicalReceiverRecipeOf(to.receiver, accepted, resolve) : undefined
  if (logicalReceiver === null) return null
  if (from.receiver !== null && to.receiver !== null && receiver === null) return null
  if (from.receiver?.kind === 'class-ref' && to.receiver?.kind === 'class-ref' && from.receiver.ancestors.includes(to.receiver.declaration))
    return null
  const parameters: ConversionNode[] = []
  const omittedArguments: ConversionNode[] = []
  const fixed = packsRest
    ? from.parameters.slice(0, from.restFrom!)
    : unpacksRest
      ? from.parameters.slice(0, to.restFrom!)
      : from.parameters
  for (const [ordinal, formal] of fixed.entries()) {
    const parameter = to.parameters[ordinal]
    if (parameter === undefined) {
      if (!carriesUndefined(formal.value)) return null
      const absent = leaf({ kind: 'undefined' }, formal.value)
      if (absent === null) return null
      omittedArguments.push(absent)
      continue
    }
    const converted = leaf(parameter.value, formal.value, true)
    if (converted === null) return null
    parameters.push(converted)
  }
  let restPacking: CallableViewPlan['restPacking']
  if (packsRest && rest?.kind === 'array-object') {
    const elements: ConversionNode[] = []
    for (const parameter of to.parameters.slice(from.restFrom!)) {
      const conversion = leaf(parameter.value, rest.element, true)
      if (conversion === null) return null
      elements.push(conversion)
    }
    restPacking = { from: from.restFrom!, array: rest, elements }
  }
  let restUnpacking: CallableViewPlan['restUnpacking']
  if (unpacksRest && (publicRest?.kind === 'array-object' || publicRest?.kind === 'record')) {
    const elements: NonNullable<CallableViewPlan['restUnpacking']>['elements'][number][] = []
    for (const [position, formal] of from.parameters.slice(to.restFrom!).entries()) {
      const actualPosition = to.argumentsFrame === 'actual' ? position + to.restFrom! : position
      const field = publicRest.kind === 'record' ? publicRest.fields.find((field) => field.key === String(actualPosition)) : null
      if (publicRest.kind === 'record' && field === undefined) return null
      const stored = publicRest.kind === 'array-object' ? publicRest.element : field!.value
      const present = leaf(stored, formal.value)
      const absent = publicRest.kind === 'array-object' || !field?.required ? leaf({ kind: 'undefined' }, formal.value) : null
      if (present === null || ((publicRest.kind === 'array-object' || !field?.required) && absent === null)) return null
      elements.push({ field: field ?? null, present, absent })
    }
    restUnpacking = { from: to.restFrom!, slot: publicRest, elements, ...(to.argumentsFrame === 'actual' ? { offset: to.restFrom! } : {}) }
  }
  // A frame that SUPPLIES the receiver a receiverless body ignores
  // (`nativeLogicalReceiverRecipeOf` above) may read its result at that
  // receiver's own class: `item.copy( source )` returning `this`,
  // `item.clone()` returning `new this.constructor()`, both typed at the
  // instance they are read off. Such a body has no physical receiver for
  // `nativeMethodFor`'s checked self-result to name, so the same checked
  // downcast is admitted here -- only into the supplied receiver's class or
  // one of its descendants, never an unrelated narrowing.
  const polymorphicSelfResult =
    from.receiver === null &&
    to.receiver?.kind === 'class-ref' &&
    to.result.kind === 'class-ref' &&
    (to.result.declaration === to.receiver.declaration || to.result.ancestors.includes(to.receiver.declaration))
  const result =
    to.result.kind === 'void'
      ? null
      : leaf(from.result.kind === 'void' ? { kind: 'undefined' } : from.result, to.result, polymorphicSelfResult)
  if (to.result.kind !== 'void' && result === null) return null
  const nodes = [
    receiver,
    ...parameters,
    ...omittedArguments,
    ...(restPacking?.elements ?? []),
    ...(restUnpacking?.elements.flatMap((element) => [element.present, element.absent]) ?? []),
    result
  ].filter((node): node is ConversionNode => node !== null)
  const addsReceiver = from.receiver === null && to.receiver !== null
  const ignoresSuffix = from.restFrom === null && to.restFrom === null && from.parameters.length < to.parameters.length
  // `(x) => number` stands where `(x) => void` is declared: the frames agree
  // leaf for leaf, yet the two native callables return different physical
  // types, so the adaptation that discards the result is itself the plan.
  const discardsResult = to.result.kind === 'void' && representationKey(from.result) !== representationKey(to.result)
  // The mirror: a `=> void` body read where its slot declares `=> undefined`
  // (a bound method read through an optional chain). The completion VALUE is
  // the same -- the result leaf is `undefined -> undefined`, an identity -- but
  // the source entry returns no C++ value, so the frame must still supply it.
  const completesResult = from.result.kind === 'void' && to.result.kind !== 'void'
  return addsReceiver ||
    ignoresSuffix ||
    discardsResult ||
    completesResult ||
    packsRest ||
    unpacksRest ||
    omittedArguments.length > 0 ||
    nodes.some((node) => node.capability.kind !== 'identity')
    ? {
        source,
        target,
        receiver,
        ...(logicalReceiver === undefined ? {} : { logicalReceiver }),
        parameters,
        result,
        ...(omittedArguments.length === 0 ? {} : { omittedArguments }),
        ...(restPacking === undefined ? {} : { restPacking }),
        ...(restUnpacking === undefined ? {} : { restUnpacking })
      }
    : null
}
