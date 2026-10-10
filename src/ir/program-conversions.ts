import type { ConversionNode } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import type { DeclarationId, FunctionId, StructuralTypeId } from '../identity/ids.js'
import { runtimeClassLayoutsOf, type ClassLayout } from '../projection/classes.js'
import { virtualDispatchVerdictOf, type VirtualMethodFamily } from '../projection/dispatch.js'
import { declaredRecordFieldOf, recordShapeLayoutsOf } from '../projection/fields.js'
import { classMethodOverrideOf } from '../projection/fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { RecordLayoutPolicy } from '../representation/policies.js'
import { representationKey, walkRepresentation, type CallableAbi, type Representation } from '../representation/model.js'
import { dynamicRecordLoadNeedsPlan } from '../conversion/document-record-view.js'
import { capturesNothing } from './captures.js'
import { asyncPromiseViewOf } from './coroutine-bodies.js'
import type { IrBody } from './model.js'
import { allOperationsOf } from './model.js'
import { nativeConstructorPropertyClassesOf } from './native-constructor-reads.js'
import { constantPropertyKeyTextOf } from './native-property-key-texts.js'
import type { ReflectionExposure } from './reflection-demand.js'

export type ProgramConversionRole =
  | 'async-entry'
  | 'construct-argument'
  | 'field-initializer'
  | 'dynamic-field-write'
  | 'prototype-method'
  | 'prototype-setter-argument'
  | 'prototype-setter-receiver'
  | 'prototype-getter-receiver'
  | 'prototype-getter-result'
  | 'virtual-receiver'
  | 'virtual-parameter'
  | 'virtual-result'
  | 'virtual-field'

/** One selected native artifact boundary, independent of operation-local conversions. */
export interface ProgramConversionInput {
  readonly role: ProgramConversionRole
  readonly owner: string
  readonly slot: string
  readonly source: Representation
  readonly target: Representation
}

export interface ProgramConversionRecipe extends ProgramConversionInput {
  readonly conversion: ConversionNode
}

export interface ProgramConversionInputs {
  readonly bodies: Iterable<IrBody>
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  readonly deriver: RepresentationDeriver
  readonly conversions: ConversionCensus
  readonly reflection?: ReflectionExposure
  /** Only the final retained native carriers can emit a field dispatcher. */
  readonly representations?: readonly Representation[]
}

/**
 * A typed string table whose entries are records: a dynamic object stored into
 * it (`this[key] = value` landing on a `Record<string, R>` field) is viewed
 * through the table's entry carrier, each entry a live view of the stored
 * object's own entry. The generic carrier adapter only admits the exact table
 * payload, so without the planned view the write refused a plain object.
 */
const dynamicTableLoadNeedsPlan = (value: Representation, layouts: RecordLayoutPolicy): boolean =>
  value.kind === 'optional'
    ? dynamicTableLoadNeedsPlan(value.payload, layouts)
    : value.kind === 'dictionary' &&
      value.key === 'string' &&
      value.ownership === 'shared-refcount' &&
      value.recursive === undefined &&
      value.value.kind !== 'dynamic' &&
      dynamicRecordLoadNeedsPlan(value.value, layouts)

/** Stable artifact identity, independent of C++ names and compatible shapes. */
export const dynamicFieldConversionOwnerOf = (
  receiver:
    | Representation
    | { readonly kind: 'record'; readonly shapeId: string }
    | { readonly kind: 'class-ref'; readonly declaration: DeclarationId }
): string | null => {
  if (receiver.kind === 'class-ref') return JSON.stringify(['class', receiver.declaration])
  return receiver.kind === 'record' || receiver.kind === 'record-with-index' || receiver.kind === 'native-record-ref'
    ? JSON.stringify(['record', receiver.shapeId])
    : null
}

/** The exact full-property class artifact inventory shared by publication and emission. */
export const prototypePropertyDeclarationsOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  reflection?: ReflectionExposure
): ReadonlySet<DeclarationId> | null => {
  if (reflection === undefined || !reflection.complete) return null
  const held = new Set<DeclarationId>()
  for (const declaration of classes.keys()) {
    const demand = reflection.classes.get(declaration)
    if (demand !== undefined && (demand.level !== 'full' || demand.fieldOperations !== undefined)) continue
    for (let base: DeclarationId | null = declaration; base !== null && !held.has(base); base = classes.get(base)?.base ?? null)
      held.add(base)
  }
  return held
}

export const prototypeSetterValue: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }

export const programConversionKey = (input: Pick<ProgramConversionInput, 'role' | 'owner' | 'slot'>): string =>
  JSON.stringify([input.role, input.owner, input.slot])

export const virtualConversionOwnerOf = (family: VirtualMethodFamily, declaration: DeclarationId): string =>
  JSON.stringify([family.root, family.key, family.role, family.copy ?? null, declaration])

/** Every conversion the final native construction, coroutine and virtual artifacts actually spell. */
export const programConversionInputsOf = (input: ProgramConversionInputs): readonly ProgramConversionInput[] => {
  const bodies = [...input.bodies]
  const byOwner = new Map(bodies.map((body) => [String(body.sourceOwner), body]))
  const abiOf = (callable: FunctionId): CallableAbi | null => byOwner.get(String(callable))?.abi ?? null
  const inputs = new Map<string, ProgramConversionInput>()
  const propertyDeclarations = prototypePropertyDeclarationsOf(input.classes, input.reflection)
  const prototypeDeclarations = new Set<DeclarationId>()
  for (const body of bodies) {
    const operations = [...body.blocks.values()].flatMap((block) => allOperationsOf(block))
    const definitions = new Map(
      operations.flatMap((operation) => (operation.kind === 'constant' ? [[operation.result.id, operation] as const] : []))
    )
    for (const operation of operations) {
      if (operation.kind !== 'get' || constantPropertyKeyTextOf(definitions.get(operation.key.value)) !== 'prototype') continue
      const receivers =
        operation.receiver.representation.kind === 'tagged-union'
          ? operation.receiver.representation.arms.map((arm) => arm.value)
          : [operation.receiver.representation]
      for (const receiver of receivers)
        for (const layout of nativeConstructorPropertyClassesOf(receiver, input.classes, 'prototype', operation.result.representation) ??
          [])
          prototypeDeclarations.add(layout.declaration)
    }
  }
  const add = (role: ProgramConversionRole, owner: string, slot: string, source: Representation, target: Representation): void => {
    if (representationKey(source) === representationKey(target)) return
    const boundary = { role, owner, slot, source, target }
    inputs.set(programConversionKey(boundary), boundary)
  }
  const layouts = recordShapeLayoutsOf(input.deriver, input.classes)
  const retained = new Map<string, Representation>()
  for (const root of input.representations ?? [])
    for (const value of walkRepresentation(root)) {
      const owner = dynamicFieldConversionOwnerOf(value)
      if (owner !== null) retained.set(owner, value)
    }
  if (input.reflection?.complete)
    for (const [owner, receiver] of retained) {
      const demand =
        receiver.kind === 'class-ref'
          ? input.reflection.classes.get(receiver.declaration)
          : 'shapeId' in receiver
            ? input.reflection.records.get(receiver.shapeId as StructuralTypeId)
            : undefined
      if (demand?.level !== 'full') continue
      const fields =
        receiver.kind === 'class-ref'
          ? input.classes.get(receiver.declaration)?.nativeStorage?.fields
          : 'shapeId' in receiver
            ? layouts.forShape(receiver.shapeId)
            : null
      for (const field of fields ?? []) {
        const operations = demand.fieldOperations?.get(field.key)
        if (demand.fieldOperations !== undefined && !operations?.has('write') && !operations?.has('define')) continue
        if (dynamicRecordLoadNeedsPlan(field.value, layouts) || dynamicTableLoadNeedsPlan(field.value, layouts))
          add('dynamic-field-write', owner, field.key, prototypeSetterValue, field.value)
      }
    }
  for (const body of bodies) {
    const view = asyncPromiseViewOf(body)
    if (view?.abi && body.abi) add('async-entry', String(body.sourceOwner), '', view.abi.result, body.abi.result)
  }
  // Construction liveness does not remove retained accessor entry bodies.
  // The prototype read/write hooks use these exact physical bodies for every
  // retained layout in the shared property demand, including layout-only
  // receivers. Construction-specific artifacts remain in the runtime domain.
  for (const layout of input.classes.values())
    if (layout.instance && (propertyDeclarations === null || propertyDeclarations.has(layout.declaration)))
      for (const accessor of layout.accessors) {
        const getter = accessor.getter === null ? null : abiOf(accessor.getter)
        if (
          getter !== null &&
          capturesNothing(byOwner.get(String(accessor.getter))?.facts) &&
          getter.parameters.length === 0 &&
          getter.restFrom === null
        ) {
          if (getter.receiver !== null)
            add('prototype-getter-receiver', String(layout.declaration), accessor.key, layout.instance, getter.receiver)
          if (getter.result.kind !== 'void')
            add('prototype-getter-result', String(layout.declaration), accessor.key, getter.result, prototypeSetterValue)
        }
        const actual = accessor.setter === null ? null : abiOf(accessor.setter)
        if (
          actual === null ||
          !capturesNothing(byOwner.get(String(accessor.setter))?.facts) ||
          actual.parameters.length !== 1 ||
          actual.restFrom !== null
        )
          continue
        add('prototype-setter-argument', String(layout.declaration), accessor.key, prototypeSetterValue, actual.parameters[0]!.value)
        if (actual.receiver !== null)
          add('prototype-setter-receiver', String(layout.declaration), accessor.key, layout.instance, actual.receiver)
      }
  for (const layout of runtimeClassLayoutsOf(input.classes)) {
    if (prototypeDeclarations.has(layout.declaration))
      for (const method of layout.methods) {
        const source = method.callable === null ? null : abiOf(method.callable)
        const slot = classMethodOverrideOf(input.classes, layout.declaration, method.key)
        if (source !== null && slot !== null)
          add('prototype-method', String(layout.declaration), method.key, { kind: 'function-value-dispatch', abi: source }, slot.value)
      }
    if (layout.constructor && layout.construct) {
      const actual = abiOf(layout.constructor)
      if (actual?.parameters.length === layout.construct.parameters.length)
        for (const [position, parameter] of actual.parameters.entries())
          add(
            'construct-argument',
            String(layout.declaration),
            String(position),
            layout.construct.parameters[position]!.value,
            parameter.value
          )
    }
    if (!layout.instance) continue
    for (const field of layout.fields) {
      if (field.initializer === null || field.representation === null) continue
      const stored = declaredRecordFieldOf(input.deriver, layout.instance, field.key, input.classes)
      if (stored !== null) add('field-initializer', String(layout.declaration), field.key, field.representation, stored.value)
    }
  }
  const verdict = virtualDispatchVerdictOf(
    input.classes,
    abiOf,
    (callable) => capturesNothing(byOwner.get(String(callable))?.facts),
    input.conversions
  )
  const virtual = (role: ProgramConversionRole, owner: string, slot: string, source: Representation, target: Representation): void => {
    // Virtual inheritance adaptation has its own authenticated allocation test;
    // only the other carriers use the conversion census.
    if (source.kind === 'class-ref' && target.kind === 'class-ref') return
    add(role, owner, slot, source, target)
  }
  for (const { family, rootAbi } of verdict.families) {
    for (const implementor of family.implementors) {
      const actual = abiOf(implementor.callable)
      const instance = input.classes.get(implementor.declaration)?.instance
      if (actual === null || actual.receiver === null || !instance) continue
      const owner = virtualConversionOwnerOf(family, implementor.declaration)
      virtual('virtual-receiver', owner, '', instance, actual.receiver)
      for (const [position, parameter] of actual.parameters.entries()) {
        const source = rootAbi.parameters[position]
        if (source) virtual('virtual-parameter', owner, String(position), source.value, parameter.value)
      }
      virtual('virtual-result', owner, '', actual.result, rootAbi.result)
    }
    for (const { declaration, field } of family.fieldImplementors ?? []) {
      if (field.representation === null) continue
      const owner = virtualConversionOwnerOf(family, declaration)
      if (family.role === 'get') virtual('virtual-field', owner, '', field.representation, rootAbi.result)
      else {
        const written = rootAbi.parameters[0]?.value
        if (written) virtual('virtual-field', owner, '', written, field.representation)
      }
    }
  }
  return [...inputs.values()]
}

export const publishProgramConversionRecipes = (input: ProgramConversionInputs): readonly ProgramConversionRecipe[] =>
  programConversionInputsOf(input).map((boundary) => ({
    ...boundary,
    conversion: programConversionNodeOf(boundary, input.conversions)
  }))

const programConversionNodeOf = (
  boundary: ProgramConversionInput,
  conversions: Pick<ConversionCensus, 'nodeFor' | 'nativeMethodFor'>
): ConversionNode =>
  (boundary.role === 'prototype-method' ? conversions.nativeMethodFor(boundary.source, boundary.target) : null) ??
  conversions.nodeFor(boundary.source, boundary.target)

/** Artifact identity, physical pair and canonical census object must all agree. */
export const programConversionRecipesMatch = (
  expected: readonly ProgramConversionInput[],
  actual: readonly ProgramConversionRecipe[],
  conversions: Pick<ConversionCensus, 'nodeFor' | 'nodeById' | 'nativeMethodFor'>
): boolean =>
  expected.length === actual.length &&
  expected.every((boundary, index) => {
    const recipe = actual[index]!
    const node = recipe.conversion
    return (
      programConversionKey(boundary) === programConversionKey(recipe) &&
      representationKey(boundary.source) === representationKey(recipe.source) &&
      representationKey(boundary.target) === representationKey(recipe.target) &&
      conversions.nodeById(node.id) === node &&
      programConversionNodeOf(boundary, conversions) === node
    )
  })
