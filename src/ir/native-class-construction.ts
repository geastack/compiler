import type { DeclarationId, FunctionId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { abiKey, representationKey, type Representation } from '../representation/model.js'
import { conversionNodeIdOf, type ConversionCensus } from '../conversion/nodes.js'
import { nativePayloadTransportMatches } from '../conversion/native-payload-transport.js'
import type { ConstructOperation, IrBody } from './model.js'
import { receivableArguments } from './call-entry.js'
import { nativeClassInitializationOf, type NativeInitializationEntry } from './native-class-initialization.js'

export interface NativeClassConstructionBranch {
  readonly declaration: DeclarationId
  readonly instance: Representation
  readonly entries: readonly NativeInitializationEntry[]
}

/** A constructor-family names implementations, unlike a constructor-value-
 * dispatch carrier, which states only a signature. Each native sum arm keeps
 * its own frame. Consume those identities and the conversion census rather
 * than treating a non-direct semantic target as an unknown implementation. */
export const nativeClassConstructionOf = (
  operation: ConstructOperation,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  bodyOf: (id: FunctionId) => IrBody | null | undefined,
  conversions?: Pick<ConversionCensus, 'nodeById'>
): readonly NativeClassConstructionBranch[] | null => {
  if (operation.callee.value !== operation.newTarget.value) return null
  const callee = operation.callee.representation
  const alternatives = callee.kind === 'tagged-union' ? callee.arms.map((arm) => arm.value) : [callee]
  if (alternatives.length === 0) return null
  const branches: NativeClassConstructionBranch[] = []
  for (const alternative of alternatives) {
    if (alternative.kind !== 'constructor-family' || alternative.members.length === 0) return null
    const abi = alternative.abi
    if (abi.receiver !== null || abi.restFrom !== null) return null
    const received = receivableArguments(abi, operation.arguments)
    // These are frame views after the cited, payload-preserving conversions,
    // not new SSA values or permission to reinterpret an emitted operand.
    const frame = []
    for (let index = 0; index < received.length; index++) {
      const source = received[index]!
      const target = abi.parameters[index]?.value
      if (!target) return null
      const node = conversions?.nodeById(conversionNodeIdOf(source.representation, target))
      if (
        representationKey(source.representation) !== representationKey(target) &&
        !nativePayloadTransportMatches(source.representation, target, node)
      )
        return null
      frame.push({ value: source.value, representation: target })
    }
    const result = operation.result.representation
    if (
      representationKey(abi.result) !== representationKey(result) &&
      !nativePayloadTransportMatches(abi.result, result, conversions?.nodeById(conversionNodeIdOf(abi.result, result)))
    )
      return null
    for (const declaration of alternative.members) {
      const layout = classes.get(declaration)
      if (!layout?.construct || !layout.instance || abiKey(layout.construct) !== abiKey(abi)) return null
      const entries = nativeClassInitializationOf(layout, frame, classes, bodyOf, conversions)
      if (entries === null) return null
      branches.push({ declaration, instance: layout.instance, entries })
    }
  }
  const targets =
    operation.target.kind === 'exact'
      ? [operation.target.target]
      : operation.target.kind === 'closed-family'
        ? operation.target.targets
        : null
  const matches = (branch: NativeClassConstructionBranch, target: NonNullable<typeof targets>[number]): boolean => {
    const layout = classes.get(branch.declaration)!
    return target.kind === 'function'
      ? target.constructable && target.functionId === layout.constructor
      : layout.constructor === null && target.classDeclaration === branch.declaration
  }
  // A later family proof may refine an open target, but cannot overrule a
  // contradictory implementation identity already published by semantics.
  if (
    targets &&
    (!branches.every((branch) => targets.some((target) => matches(branch, target))) ||
      !targets.every((target) => branches.some((branch) => matches(branch, target))))
  )
    return null
  return branches
}
