import ts from 'typescript'
import type { StructuralTypeId } from '../../identity/ids.js'
import type { PrimitiveArmDomain } from '../model/operations.js'
import { objectPrototypeMemberNames } from '../../representation/record-fields.js'
import type { ProducerContext } from './producer-context.js'
import { intactIntrinsicPrototypeKeysType } from './intrinsic-prototype.js'

type AbsenceContext = Pick<ProducerContext, 'checker' | 'identities' | 'table' | 'globalHostMutationTaint' | 'isStandardLibraryDeclaration'>

const wrappers = { string: 'String', number: 'Number', boolean: 'Boolean', bigint: 'BigInt', symbol: 'Symbol' } as const

/**
 * The primitive domains `id` holds. `others` decides a member that is no
 * primitive: the all-primitive proof fails on it, the per-arm proof skips it,
 * because each domain's answer stands on that domain's own chain alone.
 */
const primitiveDomainsOf = (context: AbsenceContext, id: StructuralTypeId, others: 'fail' | 'skip'): Set<PrimitiveArmDomain> | null => {
  const domains = new Set<PrimitiveArmDomain>()
  const collect = (member: StructuralTypeId): boolean => {
    const shape = context.table.get(member).shape
    if (shape.kind === 'union') return shape.members.every(collect)
    if (shape.kind !== 'primitive' && shape.kind !== 'literal') return others === 'skip'
    switch (shape.primitive) {
      case 'undefined':
      case 'null':
        return true // The proof describes normal completion, not throws.
      case 'string':
      case 'number':
      case 'boolean':
      case 'bigint':
      case 'symbol':
        domains.add(shape.primitive)
        return true
      default:
        return others === 'skip'
    }
  }
  return collect(id) ? domains : null
}

/**
 * Whether one domain's intrinsic prototype chain is authenticated, unmodified
 * for `name`, and declares no property under it -- or `null` when the shared
 * `Object.prototype` half of every chain already fails.
 */
const domainLacksProperty = (
  receiver: ts.Expression,
  name: string,
  context: AbsenceContext
): ((domain: PrimitiveArmDomain) => boolean) | null => {
  const { checker, globalHostMutationTaint: mutations } = context
  if (objectPrototypeMemberNames.has(name)) return null
  if (mutations.has('*') || !context.isStandardLibraryDeclaration) return null
  // The proof reads exactly one key from each prototype on the chain.
  const intactPrototypeType = (intrinsic: string): ts.Type | null =>
    intactIntrinsicPrototypeKeysType(context, intrinsic, { names: [name] }, receiver)
  const object = intactPrototypeType('Object')
  if (!object || checker.getPropertyOfType(object, name)) return null
  return (domain) => {
    // Indexed string characters are own properties even though the checker
    // does not publish an individual symbol for each possible character.
    if (domain === 'string' && /^\d+$/.test(name)) return false
    // A lexical type alias named String/Number does not replace the runtime
    // wrapper. Read the prototype of the authenticated VALUE declaration.
    const prototype = intactPrototypeType(wrappers[domain])
    return prototype !== null && !checker.getPropertyOfType(prototype, name)
  }
}

/**
 * A primitive wrapper has no own extension storage. A missing named member
 * therefore returns undefined only while its intrinsic prototype chain is
 * authenticated and unmodified. Missing checker properties alone do not prove
 * this: a program can install a property through a prototype alias.
 */
export const primitivePropertyIsAbsent = (
  receiver: ts.Expression,
  receiverType: StructuralTypeId,
  name: string,
  context: AbsenceContext
): boolean => {
  const lacks = domainLacksProperty(receiver, name, context)
  if (lacks === null) return false
  // Read the same canonical receiver type that the property operation uses.
  // rawTypeAt precedes structural rules such as local-union, so asking it
  // here could recover checker `any` after those rules already proved the
  // local holds only primitive configuration values.
  const domains = primitiveDomainsOf(context, receiverType, 'fail')
  if (domains === null || domains.size === 0) return false
  return [...domains].every(lacks)
}

/**
 * The primitive domains of a receiver that also holds objects (`string |
 * Node`, `number | Array<Varying>`) whose chain provably lacks `name`, by the
 * same proof `primitivePropertyIsAbsent` gives a wholly primitive receiver.
 *
 * Absence on the chain decides both internal methods on such an arm: [[Get]]
 * answers `undefined` (10.1.8.1), and [[Set]] finds no setter to call, so
 * OrdinarySetWithOwnDescriptor reaches a primitive Receiver and answers false
 * (10.1.9.2 step 2.b) -- a TypeError in strict code. Each domain is proven on
 * its own; an arm whose domain is not listed has no proof and keeps its
 * refusal.
 */
export const primitiveArmsLackingProperty = (
  receiver: ts.Expression,
  receiverType: StructuralTypeId,
  name: string,
  context: AbsenceContext
): readonly PrimitiveArmDomain[] => {
  const lacks = domainLacksProperty(receiver, name, context)
  if (lacks === null) return []
  const domains = primitiveDomainsOf(context, receiverType, 'skip')
  if (domains === null) return []
  return [...domains].filter(lacks)
}
