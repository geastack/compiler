import type { DeclarationId, SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { operandOf, resultOf } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { RepresentationDeriver } from './derive.js'
import type { Representation } from './model.js'
import { optionalOf } from './optional.js'

/**
 * A class's static data members, as cells.
 *
 * A static field is one property of one object -- the constructor -- so, like
 * a module `let`, it is a single cell whose history the program writes: its
 * initializer, then every `Class.key = v`. Carrier decisions that follow a
 * value by provenance (`proxy-carriers.ts`) or by what a read can observe
 * (`staticFieldAbsenceOf` below) need to name that cell from a read or write
 * of it, which is what this index answers.
 */
export interface StaticFieldCell {
  readonly declaration: DeclarationId
  /** The field's declared storage type. */
  readonly type: StructuralTypeId
  /** The value the initializer function publishes, or `null` for a field declared without one. */
  readonly initializer: SemanticResultId | null
}

export interface StaticMembers {
  /** Fields, by `class|key`. */
  readonly fields: ReadonlyMap<string, StaticFieldCell>
  /** The function value each static getter is, by `class|key`. */
  readonly getters: ReadonlyMap<string, SemanticResultId>
  /**
   * The `class|key` a constant-keyed property operation names, when its
   * receiver can only be one class's constructor object. A member inherited
   * from a base, or a receiver this cannot name, answers `null`: its position
   * keeps its declared carrier, and whatever that loses refuses by name at the
   * conversion into it.
   */
  readonly memberOf: (operation: SemanticOperation) => string | null
}

const memberKey = (declaration: DeclarationId, key: string): string => `${declaration}|${key}`

export const staticMembersOf = (graph: SemanticGraph, deriver: Pick<RepresentationDeriver, 'derive'>): StaticMembers => {
  const fields = new Map<string, StaticFieldCell>()
  const getters = new Map<string, SemanticResultId>()
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'class-lifecycle' || operation.placement !== 'static') continue
    const key = operandOf(operation, 'key')
    if (key?.source.kind !== 'constant') continue
    if (operation.event === 'define-field') {
      const storage = operandOf(operation, 'field-storage')
      if (!storage) continue
      const initializer = operandOf(operation, 'initializer')
      fields.set(memberKey(operation.classDeclaration, key.source.text), {
        declaration: operation.declaration,
        type: storage.type,
        initializer: initializer?.source.kind === 'result' ? initializer.source.result : null
      })
    } else if (operation.event === 'define-getter') {
      const getter = operandOf(operation, 'method')
      if (getter?.source.kind === 'result') getters.set(memberKey(operation.classDeclaration, key.source.text), getter.source.result)
    }
  }
  // Answered once per operation: the proxy walk asks it on every pass of its
  // fixed point, and a receiver's carrier is a derivation, not a field read.
  const answered = new Map<SemanticOperation, string | null>()
  const memberOf = (operation: SemanticOperation): string | null => {
    if (operation.family !== 'property' || operation.keyIsComputed || (fields.size === 0 && getters.size === 0)) return null
    const known = answered.get(operation)
    if (known !== undefined) return known
    const receiver = operandOf(operation, 'receiver')
    const key = operandOf(operation, 'key')
    let member: string | null = null
    if (receiver && key?.source.kind === 'constant') {
      const carrier = deriver.derive(receiver.type)
      const declaration =
        carrier.kind === 'constructor-identity'
          ? carrier.declaration
          : carrier.kind === 'constructor-family' && carrier.members.length === 1
            ? carrier.members[0]
            : undefined
      member = declaration === undefined ? null : memberKey(declaration, key.source.text)
    }
    answered.set(operation, member)
    return member
  }
  return { fields, getters, memberOf }
}

/** Whether a carrier already has a place for `undefined`. */
const admitsUndefined = (carrier: Representation): boolean =>
  (carrier.kind === 'optional' && carrier.absence === 'undefined') ||
  carrier.kind === 'undefined' ||
  (carrier.kind === 'tagged-union' && carrier.arms.some((arm) => admitsUndefined(arm.value)))

/**
 * The static fields declared without an initializer, and every read of one.
 *
 * `static x: T` with no initializer defines the property as `undefined`
 * (ECMA-262 DefineField with an empty initializer), and the checker never
 * requires a static to be definitely assigned -- `strictPropertyInitialization`
 * covers instance fields only. So such a field's declared type is a claim the
 * language does not enforce: until the first write, every read observes
 * `undefined`. A lazily loaded `Provider._sdk ??= load()` is the
 * idiom that relies on it; carried as its declared `T`, the `??` sees no
 * absence and never loads.
 *
 * The cell and every read of it therefore carry the absence the program can
 * observe. A read feeding a position that states `T` converts through the
 * ordinary checked unwrap, which is where the unsoundness the checker allowed
 * surfaces -- never as a load of storage nothing wrote.
 */
export interface StaticFieldAbsence {
  readonly fields: ReadonlySet<DeclarationId>
  readonly reads: ReadonlySet<SemanticResultId>
}

export const staticFieldAbsenceOf = (graph: SemanticGraph, members: StaticMembers): StaticFieldAbsence => {
  const fields = new Set<DeclarationId>()
  for (const field of members.fields.values()) if (field.initializer === null) fields.add(field.declaration)
  const reads = new Set<SemanticResultId>()
  if (fields.size === 0) return { fields, reads }
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'property' || operation.internalMethod !== 'get') continue
    const member = members.memberOf(operation)
    const field = member === null ? undefined : members.fields.get(member)
    const value = resultOf(operation, 'value')
    if (field && value && fields.has(field.declaration)) reads.add(value.id)
  }
  return { fields, reads }
}

/** `carrier` with the `undefined` an unwritten static field holds. */
export const withStaticFieldAbsence = (carrier: Representation): Representation =>
  admitsUndefined(carrier) ? carrier : optionalOf(carrier, 'undefined')
