import { isNativeCallableCarrier } from '../representation/callable-object.js'
import type { Representation } from '../representation/model.js'
import { allOperationsOf, type IrBody } from './model.js'
import type { IrValueId } from '../identity/ids.js'

export interface FunctionReflectionDemand {
  readonly facts: boolean
  readonly sources: boolean
}

const holdsCallable = (representation: Representation): boolean =>
  isNativeCallableCarrier(representation.kind) ||
  (representation.kind === 'optional' && holdsCallable(representation.payload)) ||
  (representation.kind === 'tagged-union' && representation.arms.some((arm) => holdsCallable(arm.value)))

const reflectiveObjectMembers: ReadonlySet<string> = new Set([
  'getOwnPropertyDescriptor',
  'getOwnPropertyNames',
  'hasOwn',
  'defineProperty',
  'keys',
  'entries',
  'values'
])

/**
 * Minted Function objects need their observable facts before entering an unknown value boundary.
 * Certified conversions inside calls and native logical receiver entries are boundaries too;
 * neither necessarily introduces a standalone Convert operation.
 */
export const functionReflectionDemandOf = (bodies: Iterable<IrBody>): FunctionReflectionDemand => {
  let facts = false
  for (const body of bodies) {
    const operations = [...body.blocks.values()].flatMap(allOperationsOf)
    const keys = new Map(
      operations.flatMap((operation) =>
        operation.kind === 'constant' && operation.literal === 'string' ? [[operation.result.id, operation.text] as const] : []
      )
    )
    const reflectors = new Set<IrValueId>()
    for (const operation of operations) {
      if ((operation.kind === 'set' || operation.kind === 'call') && operation.nativeCallableDataWrite !== undefined)
        return { facts: true, sources: true }
      if (
        operation.conversionRecipes?.some((recipe) => holdsCallable(recipe.source) && recipe.target.kind === 'dynamic') ||
        (operation.kind === 'convert' &&
          holdsCallable(operation.source.representation) &&
          operation.result.representation.kind === 'dynamic')
      )
        return { facts: true, sources: true }
      if (operation.kind === 'call') {
        const logical = operation.thisArgument ?? operation.receiver
        if (logical && holdsCallable(logical.representation)) return { facts: true, sources: true }
      }
      if (operation.kind === 'bind-callable' && operation.thisArgument && holdsCallable(operation.thisArgument.representation))
        return { facts: true, sources: true }
      if (
        operation.kind === 'compute' &&
        operation.form !== 'typeof' &&
        operation.operator !== '===' &&
        operation.operator !== '!==' &&
        operation.operands.some((operand) => holdsCallable(operand.representation))
      )
        return { facts: true, sources: true }
      if (operation.kind === 'get') {
        if (holdsCallable(operation.receiver.representation)) {
          const key = keys.get(operation.key.value)
          if (key === 'name' || key === 'length') facts = true
          else if (key === undefined || key === 'toString') return { facts: true, sources: true }
        }
        const receiver = operation.receiver.representation
        const member =
          operation.hostMethod?.protocol === 'ObjectConstructor'
            ? operation.hostMethod.member
            : receiver.kind === 'native-handle' && (receiver.native ?? receiver.protocol) === 'ObjectConstructor'
              ? keys.get(operation.key.value)
              : undefined
        if (member !== undefined && reflectiveObjectMembers.has(member)) reflectors.add(operation.result.id)
      }
      if (
        operation.kind === 'call' &&
        reflectors.has(operation.callee.value) &&
        operation.arguments.some((argument) => holdsCallable(argument.representation))
      )
        return { facts: true, sources: true }
    }
  }
  return { facts, sources: false }
}
