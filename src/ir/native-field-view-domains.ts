import type { ConversionNode } from '../conversion/algebra.js'
import { nativeFieldViewPlansOf, type NativeFieldViewPlan } from '../conversion/native-field-view.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type CallableAbi, type Representation } from '../representation/model.js'
import type { FunctionId, StructuralTypeId } from '../identity/ids.js'
import type { DeclarationId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { classMemberOf } from '../projection/fields.js'
import { extendsClass } from '../projection/dispatch.js'
import { abiOfCallee } from '../projection/callee.js'
import { nativeDataPropertyOf } from '../representation/native-data-properties.js'

export interface NativeFieldStorageDomain {
  readonly read: Representation
  readonly write: Representation | null
  /** A selected checked view reader follows its original physical storage through chained views. */
  readonly checkedRead?: ConversionNode
  readonly declaredAnyEntry?: true
  /** The actual ordinary allocation has no descriptor, and its intact prototype lacks this exact key. */
  readonly originalAbsent?: true
  /** A descriptor-forwarding view whose immediate source has no route for the
   * key: the read answers from the source's expando table. A proved own
   * descriptor excludes it. */
  readonly sourceAbsent?: true
  /** A union's `dynamic` arm: the read is that `gea::Value`'s own [[Get]]. */
  readonly dynamicGet?: true
  /**
   * A union's binary-view arm (`typed-array`, `data-view`, `array-buffer`):
   * the read is that arm's own native data property (`nativeDataPropertyOf`),
   * which no descriptor can replace -- `buffer`, `byteOffset` and
   * `byteLength` are prototype accessors over the view's internal slots.
   */
  readonly nativeData?: true
}

export interface NativeFieldViewDomains {
  (receiver: Representation): ReadonlyMap<string, readonly NativeFieldStorageDomain[]> | null
  /**
   * The routes of a static key no installed plan or layout of a live record
   * carrier names (`options.mapping` over a `setOptions( options = {} )`
   * parameter): each original allocation behind the view answers from its
   * expando table -- `undefined`, or a carrier a copy stored there -- and an
   * installed Document view answers its own entry, a declared `any`. A
   * `null` key is any runtime key outside every named descriptor.
   */
  readonly absentRoutesOf: (receiver: Representation, key: string | null) => readonly NativeFieldStorageDomain[] | null
}

const binaryViewDataKeys = ['buffer', 'byteLength', 'byteOffset', 'length', 'BYTES_PER_ELEMENT'] as const

const isDocumentPlan = (plan: NativeFieldViewPlan): boolean =>
  plan.source.kind === 'dictionary' && plan.fields.every((field) => field.declaredAnyEntry === true)

/** The identity of one receiver's store of a forwarded key no source declares (`NativeCallableFlow.nativeFieldViewForwardedWrites`). */
export const nativeFieldViewForwardedWriteKey = (receiver: string, key: string): string => JSON.stringify([receiver, key])

/** The installed live plans by target shape, as `nativeFieldViewDomainsOf` indexes them. */
export const nativeFieldViewPlansByTargetOf = (nodes: Iterable<ConversionNode>): ReadonlyMap<string, readonly NativeFieldViewPlan[]> => {
  const plans = new Map<string, NativeFieldViewPlan[]>()
  for (const plan of nativeFieldViewPlansOf(nodes)) {
    const entries = plans.get(plan.target.shapeId) ?? []
    if (!entries.includes(plan)) entries.push(plan)
    plans.set(plan.target.shapeId, entries)
  }
  return plans
}

/**
 * Where a store of a runtime key outside every named descriptor lands, for a
 * value carried as `receiver` (`data[key] = v` over a live view target): the
 * record carriers whose own expando takes it -- the plain allocation itself
 * and, through each installed live plan, its original source -- or null when
 * some allocation behind the carrier has no certified home for an undeclared
 * key. An installed Document view stores the key as its own entry, and an
 * indexed record's plain allocation in its index sidecar; neither is an
 * expando home. A class instance, a native base, a view whose source keeps
 * undeclared keys in an index sidecar, and any union are homes this proof
 * does not cover, so the store stays refused there. `named` is every key a
 * slot, accessor or installed descriptor along the way declares: a store of
 * one of those takes its route, never a home.
 */
export const nativeFieldViewOpenWriteHomesOf = (
  receiver: Representation,
  plans: ReadonlyMap<string, readonly NativeFieldViewPlan[]>,
  layoutOf: Pick<RepresentationDeriver, 'layoutOf'> | null | undefined
): { readonly homes: readonly Representation[]; readonly named: ReadonlySet<string> } | null => {
  if (receiver.kind === 'optional' || receiver.kind === 'borrowed-ref')
    return nativeFieldViewOpenWriteHomesOf(receiver.kind === 'optional' ? receiver.payload : receiver.referent, plans, layoutOf)
  if (receiver.kind !== 'record' && receiver.kind !== 'record-with-index' && receiver.kind !== 'native-record-ref') return null
  if (receiver.ownership !== 'shared-refcount') return null
  const installed = plans.get(receiver.shapeId)
  if (!installed?.length) return null
  const named = new Set<string>()
  const name = (keys: Iterable<{ readonly key: string }>): void => {
    for (const { key } of keys) named.add(key)
  }
  if (receiver.kind === 'record-with-index') {
    if (!installed.every(isDocumentPlan)) return null
    name(receiver.fields)
    for (const plan of installed) name(plan.fields)
    return { homes: [], named }
  }
  const homes: Representation[] = []
  const pending: Representation[] = [receiver]
  const seen = new Set<string>()
  while (pending.length > 0) {
    const carrier = pending.pop()!
    const identity = representationKey(carrier)
    if (seen.has(identity)) continue
    seen.add(identity)
    if ((carrier.kind !== 'record' && carrier.kind !== 'native-record-ref') || carrier.ownership !== 'shared-refcount') return null
    const ordinary =
      carrier.kind === 'native-record-ref'
        ? carrier.native === null
          ? layoutOf?.layoutOf(carrier.shapeId as StructuralTypeId)
          : null
        : carrier
    if (ordinary?.kind !== 'record') return null
    homes.push(carrier)
    name(ordinary.fields)
    name(ordinary.accessors)
    for (const plan of plans.get(carrier.shapeId) ?? []) {
      name(plan.fields)
      if (!isDocumentPlan(plan)) pending.push(plan.source)
    }
  }
  return { homes, named }
}

/**
 * A callback's physical descriptor remains fixed when its Function identity
 * escapes. Enumerate only installed live allocation plans, plus the ordinary
 * allocation of the same native target, and projected native class storage.
 * A public field type alone never installs a live descriptor.
 */
export const nativeFieldViewDomainsOf = (
  nodes: Iterable<ConversionNode>,
  layoutOf: Pick<RepresentationDeriver, 'layoutOf'> | null | undefined,
  abiOf: (id: FunctionId) => CallableAbi | null,
  classes: ReadonlyMap<DeclarationId, ClassLayout> = new Map(),
  /** The native carriers copies store under `key` in the expando of an
   * allocation carried as `shapeId` (`spread-conversions.ts`'s `expandoData`). */
  expandoStoredOf: (shapeId: string, key: string | null) => readonly Representation[] = () => []
): NativeFieldViewDomains => {
  const plans = new Map<string, NativeFieldViewPlan[]>()
  for (const plan of nativeFieldViewPlansOf(nodes)) {
    const entries = plans.get(plan.target.shapeId) ?? []
    if (!entries.includes(plan)) entries.push(plan)
    plans.set(plan.target.shapeId, entries)
  }
  const cache = new Map<string, ReadonlyMap<string, readonly NativeFieldStorageDomain[]> | null>()
  /**
   * Whether no allocation this carrier can hold has `key` as an own slot,
   * accessor, class member, or descriptor route -- so its ordinary [[Get]]
   * reaches only the expando table and then `Object.prototype`, whose own
   * absence of the key is the operation's separate proof
   * (`ordinaryObjectPrototypeKeyAbsent`). A live view counts only when every
   * installed plan's source is itself absent: a key it does not route
   * delegates to that source. An index signature, a dictionary, a native
   * base, or an unknown layout can hold any key, so they never are.
   */
  const keyAbsentIn = (receiver: Representation, key: string, seen: Set<string>): boolean => {
    if (receiver.kind === 'optional') return keyAbsentIn(receiver.payload, key, seen)
    if (receiver.kind === 'borrowed-ref') return keyAbsentIn(receiver.referent, key, seen)
    if (receiver.kind === 'tagged-union')
      return receiver.arms.every((arm) => arm.value.kind === 'undefined' || arm.value.kind === 'null' || keyAbsentIn(arm.value, key, seen))
    const identity = representationKey(receiver)
    if (seen.has(identity)) return true
    seen.add(identity)
    // A copy that stored a native carrier in the expando under this key makes
    // the expando read typed, not `undefined`.
    if ('shapeId' in receiver && expandoStoredOf(receiver.shapeId, key).length > 0) return false
    if (receiver.kind === 'class-ref') {
      if (receiver.ownership !== 'shared-refcount' || !classes.has(receiver.declaration)) return false
      return [...classes.values()].every(
        (layout) =>
          layout.allocationAbsent === true ||
          (layout.declaration !== receiver.declaration && !extendsClass(classes, layout.declaration, receiver.declaration)) ||
          (layout.nativeBase === null &&
            layout.nativeStorage !== undefined &&
            !layout.nativeStorage.fields.some((field) => field.key === key) &&
            classMemberOf(classes, layout.declaration, key) === null)
      )
    }
    if ((receiver.kind !== 'record' && receiver.kind !== 'native-record-ref') || receiver.ownership !== 'shared-refcount') return false
    const ordinary =
      receiver.kind === 'native-record-ref'
        ? receiver.native === null
          ? layoutOf?.layoutOf(receiver.shapeId as StructuralTypeId)
          : null
        : receiver
    if (ordinary?.kind !== 'record') return false
    if (ordinary.fields.some((field) => field.key === key) || ordinary.accessors.some((accessor) => accessor.key === key)) return false
    return (plans.get(receiver.shapeId) ?? []).every(
      (plan) => !plan.fields.some((field) => field.key === key) && keyAbsentIn(plan.source, key, seen)
    )
  }
  /**
   * Whether a plain allocation of `source` stores `key` in its own slot or
   * accessor. A forwarded key a source's layout does not declare is answered
   * from that allocation's expando -- even when the source is itself a view
   * target whose installed plans route the key: the plain allocation has no
   * such route, and its expando may be empty.
   */
  const ordinaryDeclares = (source: Representation, key: string): boolean => {
    if (source.kind === 'optional' || source.kind === 'borrowed-ref')
      return ordinaryDeclares(source.kind === 'optional' ? source.payload : source.referent, key)
    const ordinary =
      source.kind === 'native-record-ref'
        ? source.native === null
          ? layoutOf?.layoutOf(source.shapeId as StructuralTypeId)
          : null
        : source
    if (ordinary?.kind !== 'record' && ordinary?.kind !== 'record-with-index') return true
    return (
      ordinary.fields.some((field) => field.key === key) ||
      (ordinary.kind === 'record' && ordinary.accessors.some((accessor) => accessor.key === key))
    )
  }
  const domainsOf = (receiver: Representation, ordinaryArm = false): ReadonlyMap<string, readonly NativeFieldStorageDomain[]> | null => {
    const identity = `${representationKey(receiver)}:${ordinaryArm ? 'ordinary' : 'live'}`
    if (cache.has(identity)) return cache.get(identity) ?? null
    if (receiver.kind === 'optional' || receiver.kind === 'borrowed-ref')
      return domainsOf(receiver.kind === 'optional' ? receiver.payload : receiver.referent, ordinaryArm)
    if (receiver.kind === 'tagged-union') {
      // A `dynamic` arm is already a `gea::Value` (`decorate(decrypted[k], ...)`
      // recursing with an `any` entry): its read is that Value's own [[Get]],
      // converted by the same leaf as every other route. Nothing is boxed.
      const dynamicArms = receiver.arms.filter((arm) => arm.value.kind === 'dynamic')
      const objectArms = receiver.arms.filter(
        (arm) => arm.value.kind !== 'undefined' && arm.value.kind !== 'null' && arm.value.kind !== 'dynamic'
      )
      if (!ordinaryArm && !objectArms.some((arm) => domainsOf(arm.value) !== null)) return null
      const arms = objectArms.map((arm) => domainsOf(arm.value, true))
      if (!arms.length || arms.some((arm) => arm === null)) return null
      // A per-arm union, not an intersection: `(message as LogConvertible).toLog`
      // over `StartedEvent | LoggableSucceeded | LogConvertible` names a key only
      // one arm stores. Every other arm contributes the certified absence of
      // its ordinary allocation -- a `get` answers its expando entry or
      // `undefined` -- and only where that absence is provable (`keyAbsentIn`);
      // one unprovable arm drops the key, exactly as the intersection did.
      const common = new Map<string, NativeFieldStorageDomain[]>()
      for (const key of new Set(arms.flatMap((arm) => [...arm!.keys()]))) {
        const routes: NativeFieldStorageDomain[] = []
        let complete = true
        for (const [index, arm] of arms.entries()) {
          const held = arm!.get(key)
          if (held !== undefined) routes.push(...held)
          else if (keyAbsentIn(objectArms[index]!.value, key, new Set())) {
            if (!routes.some((route) => route.originalAbsent === true))
              routes.push({ read: { kind: 'undefined' }, write: null, originalAbsent: true })
          } else {
            complete = false
            break
          }
        }
        if (!complete) continue
        for (const arm of dynamicArms)
          if (!routes.some((route) => route.dynamicGet === true && representationKey(route.read) === representationKey(arm.value)))
            routes.push({ read: arm.value, write: null, dynamicGet: true })
        common.set(key, routes)
      }
      cache.set(identity, common)
      return common
    }
    // A binary view beside a live record view in one union -- node-compat's
    // `BodyInit` holds `Buffer` and `ArrayBufferView<ArrayBuffer>`, and the
    // latter is a live view of a Document a dynamic body was read as. Only as
    // an ordinary union arm: a binary view is never itself a view target.
    if (ordinaryArm && (receiver.kind === 'typed-array' || receiver.kind === 'data-view' || receiver.kind === 'array-buffer')) {
      const fields = new Map<string, NativeFieldStorageDomain[]>()
      for (const key of binaryViewDataKeys) {
        const property = nativeDataPropertyOf(receiver, key)
        if (property !== null) fields.set(key, [{ read: property.result, write: null, nativeData: true }])
      }
      cache.set(identity, fields)
      return fields
    }
    if (receiver.kind === 'class-ref' && receiver.ownership === 'shared-refcount') {
      if (!classes.has(receiver.declaration)) return null
      const family = [...classes.values()].filter(
        (layout) =>
          layout.allocationAbsent !== true &&
          (layout.declaration === receiver.declaration || extendsClass(classes, layout.declaration, receiver.declaration))
      )
      if (!family.length || family.some((layout) => layout.nativeBase !== null || layout.nativeStorage === undefined)) return null
      const arms: Map<string, NativeFieldStorageDomain[]>[] = []
      for (const layout of family) {
        const fields = new Map<string, NativeFieldStorageDomain[]>(
          layout.nativeStorage!.fields.map((field) => [field.key, [{ read: field.value, write: field.value }]])
        )
        const walked = new Set<DeclarationId>()
        for (
          let declaration: DeclarationId | null = layout.declaration;
          declaration !== null && !walked.has(declaration);
          declaration = classes.get(declaration)?.base ?? null
        ) {
          walked.add(declaration)
          for (const accessor of classes.get(declaration)?.accessors ?? []) {
            const selected = classMemberOf(classes, layout.declaration, accessor.key)
            if (selected?.kind !== 'accessor' || selected.owner !== declaration) continue
            const getter = accessor.getter === null ? null : abiOf(accessor.getter)
            const setter = accessor.setter === null ? null : abiOf(accessor.setter)
            // An accessor with no admitted ABI (a getter nothing calls has
            // no body) states no route for ITS key; it does not void the
            // class's other members. node-compat's `ResponseImpl` declares
            // every WHATWG attribute as a getter and hono reads only
            // `headers` off `Response | ResponseInit`.
            if (
              !getter ||
              getter.parameters.length !== 0 ||
              getter.restFrom !== null ||
              (accessor.setter !== null && (!setter || setter.parameters.length !== 1 || setter.restFrom !== null))
            ) {
              fields.delete(accessor.key)
              continue
            }
            const read =
              getter.result.kind === 'void' ? accessor.representation && abiOfCallee(accessor.representation)?.result : getter.result
            if (read === undefined || (getter.result.kind === 'void' && read.kind !== 'undefined')) {
              fields.delete(accessor.key)
              continue
            }
            fields.set(accessor.key, [{ read, write: setter?.parameters[0]?.value ?? null }])
          }
        }
        arms.push(fields)
      }
      const fields = new Map<string, readonly NativeFieldStorageDomain[]>()
      for (const key of arms[0]!.keys())
        if (arms.every((arm) => arm.has(key)))
          fields.set(
            key,
            arms.flatMap((arm) => arm.get(key)!)
          )
      cache.set(identity, fields)
      return fields
    }
    if (
      (receiver.kind !== 'record' && receiver.kind !== 'record-with-index' && receiver.kind !== 'native-record-ref') ||
      receiver.ownership !== 'shared-refcount'
    )
      return null
    const installed = plans.get(receiver.shapeId)
    if (!ordinaryArm && !installed?.length) return null
    // Install the accumulator before following a recursive view's source.
    // The physical leaf route itself is still present on each cycle edge.
    const fields = new Map<string, NativeFieldStorageDomain[]>()
    cache.set(identity, fields)
    const add = (key: string, domain: NativeFieldStorageDomain): void => {
      const entries = fields.get(key) ?? []
      const same = (held: NativeFieldStorageDomain): boolean =>
        representationKey(held.read) === representationKey(domain.read) &&
        held.checkedRead?.id === domain.checkedRead?.id &&
        held.declaredAnyEntry === domain.declaredAnyEntry &&
        held.sourceAbsent === domain.sourceAbsent &&
        (held.write === null
          ? domain.write === null
          : domain.write !== null && representationKey(held.write) === representationKey(domain.write))
      if (!entries.some(same))
        entries.push({
          read: domain.read,
          write: domain.write,
          ...(domain.checkedRead ? { checkedRead: domain.checkedRead } : {}),
          ...(domain.declaredAnyEntry ? { declaredAnyEntry: true } : {}),
          ...(domain.sourceAbsent ? { sourceAbsent: true } : {})
        })
      fields.set(key, entries)
    }
    const ordinary =
      receiver.kind === 'native-record-ref'
        ? receiver.native === null
          ? layoutOf?.layoutOf(receiver.shapeId as StructuralTypeId)
          : null
        : receiver
    if (ordinary?.kind !== 'record' && ordinary?.kind !== 'record-with-index') {
      cache.set(identity, null)
      return null
    }
    const forwarded = new Set(
      (installed ?? []).flatMap((plan) => plan.fields.flatMap((field) => (field.descriptorForward ? [field.key] : [])))
    )
    for (const field of ordinary.fields) if (!forwarded.has(field.key)) add(field.key, { read: field.value, write: field.value })
    for (const accessor of ordinary.kind === 'record' ? ordinary.accessors : []) {
      const getter = accessor.getter === null ? null : abiOf(accessor.getter)
      const setter = accessor.setter === null ? null : abiOf(accessor.setter)
      if (
        !getter ||
        getter.parameters.length !== 0 ||
        getter.restFrom !== null ||
        (accessor.setter !== null && (!setter || setter.parameters.length !== 1 || setter.restFrom !== null))
      ) {
        cache.set(identity, null)
        return null
      }
      const read = getter.result.kind === 'void' ? accessor.value : getter.result
      if (getter.result.kind === 'void' && read.kind !== 'undefined') {
        cache.set(identity, null)
        return null
      }
      add(accessor.key, { read, write: setter?.parameters[0]?.value ?? null })
    }
    for (const plan of installed ?? []) {
      // The public intermediate view may omit a key. Its native descriptor
      // still delegates that key to the immediate source, including a getter
      // whose Function identity has escaped.
      const inherited = domainsOf(plan.source, true)
      for (const [key, domains] of inherited ?? []) {
        const checked = plan.fields.find((field) => field.key === key)?.checkedRead
        for (const domain of domains) add(key, checked ? { ...domain, checkedRead: checked } : domain)
      }
      for (const field of plan.fields) {
        if (!field.descriptorForward) add(field.key, field)
        // A forwarded key the source never stores answers from its expando
        // table, which without an own descriptor reads `undefined`, and
        // otherwise holds whatever native carrier a copy stored there. The
        // forward reads that expando and nothing else, so its answers do not
        // depend on whether the source's own layout is known: an unresolved
        // source still answers `undefined` for a key it never received.
        else if (inherited === null || !inherited.has(field.key) || !ordinaryDeclares(plan.source, field.key)) {
          add(field.key, { read: { kind: 'undefined' }, write: null, sourceAbsent: true })
          if ('shapeId' in plan.source)
            for (const stored of expandoStoredOf(plan.source.shapeId, field.key)) add(field.key, { read: stored, write: null })
        }
      }
    }
    return fields
  }
  const absentRoutesOf = (receiver: Representation, key: string | null): readonly NativeFieldStorageDomain[] | null => {
    if (receiver.kind === 'optional' || receiver.kind === 'borrowed-ref')
      return absentRoutesOf(receiver.kind === 'optional' ? receiver.payload : receiver.referent, key)
    if ((receiver.kind !== 'record' && receiver.kind !== 'native-record-ref') || receiver.ownership !== 'shared-refcount') return null
    const installed = plans.get(receiver.shapeId)
    const named = domainsOf(receiver)
    if (!installed?.length || named === null || (key !== null && named.has(key))) return null
    const routes: NativeFieldStorageDomain[] = []
    const add = (route: NativeFieldStorageDomain): void => {
      if (
        !routes.some(
          (held) => representationKey(held.read) === representationKey(route.read) && held.originalAbsent === route.originalAbsent
        )
      )
        routes.push(route)
    }
    const pending: Representation[] = [receiver]
    const seen = new Set<string>()
    while (pending.length > 0) {
      const carrier = pending.pop()!
      const identity = representationKey(carrier)
      if (seen.has(identity)) continue
      seen.add(identity)
      if ((carrier.kind !== 'record' && carrier.kind !== 'native-record-ref') || carrier.ownership !== 'shared-refcount') return null
      const ordinary =
        carrier.kind === 'native-record-ref'
          ? carrier.native === null
            ? layoutOf?.layoutOf(carrier.shapeId as StructuralTypeId)
            : null
          : carrier
      if (ordinary?.kind !== 'record') return null
      if (
        key !== null &&
        (ordinary.fields.some((field) => field.key === key) || ordinary.accessors.some((accessor) => accessor.key === key))
      )
        return null
      // The allocation itself, when this carrier is no view: its ordinary
      // [[Get]] misses every slot and reads the expando table.
      add({ read: { kind: 'undefined' }, write: null, originalAbsent: true })
      for (const stored of expandoStoredOf(carrier.shapeId, key)) add({ read: stored, write: null })
      for (const plan of plans.get(carrier.shapeId) ?? []) {
        if (key !== null && plan.fields.some((field) => field.key === key)) return null
        if (isDocumentPlan(plan)) {
          if (plan.source.kind === 'dictionary') add({ read: plan.source.value, write: null, declaredAnyEntry: true })
          continue
        }
        pending.push(plan.source)
      }
    }
    return routes
  }
  return Object.assign(domainsOf, { absentRoutesOf })
}
