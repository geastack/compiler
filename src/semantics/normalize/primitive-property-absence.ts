import ts from 'typescript'
import type { StructuralTypeId } from '../../identity/ids.js'
import { objectPrototypeMemberNames } from '../../representation/record-fields.js'
import type { ProducerContext } from './producer-context.js'
import { intactIntrinsicPrototypeKeysType } from './intrinsic-prototype.js'

type AbsenceContext = Pick<ProducerContext, 'checker' | 'identities' | 'table' | 'globalHostMutationTaint' | 'isStandardLibraryDeclaration'>

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
  const { checker, globalHostMutationTaint: mutations } = context
  if (objectPrototypeMemberNames.has(name)) return false
  if (mutations.has('*') || !context.isStandardLibraryDeclaration) return false
  // Read the same canonical receiver type that the property operation uses.
  // rawTypeAt precedes structural rules such as local-union, so asking it
  // here could recover checker `any` after those rules already proved the
  // local holds only primitive configuration values.
  const domains = new Set<'string' | 'number' | 'boolean' | 'bigint' | 'symbol'>()
  const collect = (id: StructuralTypeId): boolean => {
    const shape = context.table.get(id).shape
    if (shape.kind === 'union') return shape.members.every(collect)
    if (shape.kind !== 'primitive' && shape.kind !== 'literal') return false
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
        return false
    }
  }
  if (!collect(receiverType) || domains.size === 0) return false
  // The proof reads exactly one key from each prototype on the chain.
  const intactPrototypeType = (intrinsic: string): ts.Type | null =>
    intactIntrinsicPrototypeKeysType(context, intrinsic, { names: [name] }, receiver)
  const object = intactPrototypeType('Object')
  if (!object || checker.getPropertyOfType(object, name)) return false
  const wrappers = { string: 'String', number: 'Number', boolean: 'Boolean', bigint: 'BigInt', symbol: 'Symbol' } as const
  return [...domains].every((domain) => {
    // Indexed string characters are own properties even though the checker
    // does not publish an individual symbol for each possible character.
    if (domain === 'string' && /^\d+$/.test(name)) return false
    const intrinsic = wrappers[domain]
    // A lexical type alias named String/Number does not replace the runtime
    // wrapper. Read the prototype of the authenticated VALUE declaration.
    const prototype = intactPrototypeType(intrinsic)
    return prototype !== null && !checker.getPropertyOfType(prototype, name)
  })
}
