import type { DeclarationId, FunctionId } from '../identity/ids.js'
import { constructedBaseOf, type ClassLayout } from '../projection/classes.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { representationKey } from '../representation/model.js'
import type { IrBody, IrOperand, SuperInitializeOperation } from './model.js'
import { nativeArgumentsMatch, receivableArguments } from './call-entry.js'
import { classConstructorBodyMatches } from './construct-entry.js'

export interface NativeInitializationEntry {
  readonly functionId: FunctionId
  readonly arguments: readonly IrOperand[]
}

/** Existing-receiver initialization follows the projected class lifecycle.
 * An implicit derived constructor forwards its received frame to its base;
 * a written constructor enters its body, whose super operation owns that edge.
 * No instance is published merely by traversing this native call chain. */
export const nativeClassInitializationOf = (
  layout: ClassLayout,
  args: readonly IrOperand[],
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  bodyOf: (id: FunctionId) => IrBody | null | undefined,
  conversions?: Pick<ConversionCensus, 'nodeById'>,
  visiting = new Set<DeclarationId>()
): readonly NativeInitializationEntry[] | null => {
  if (
    visiting.has(layout.declaration) ||
    layout.nativeBase !== null ||
    layout.instance === null ||
    layout.construct === null ||
    !nativeArgumentsMatch(layout.construct, args, conversions)
  )
    return null
  visiting.add(layout.declaration)
  const entries: NativeInitializationEntry[] = []
  const received = receivableArguments(layout.construct, args)
  if (layout.constructor !== null) {
    const body = bodyOf(layout.constructor)
    if (!body || !classConstructorBodyMatches(layout, body)) return null
    entries.push({ functionId: layout.constructor, arguments: received })
  } else if (constructedBaseOf(layout) !== null) {
    const base = classes.get(constructedBaseOf(layout)!)
    const inherited = base ? nativeClassInitializationOf(base, received, classes, bodyOf, conversions, visiting) : null
    if (inherited === null) return null
    entries.push(...inherited)
  }
  for (const field of layout.fields) {
    if (field.initializer === null) continue
    const frame = bodyOf(field.initializer)?.abi
    if (
      !frame ||
      frame.receiver === null ||
      representationKey(frame.receiver) !== representationKey(layout.instance) ||
      frame.parameters.length !== 0 ||
      frame.restFrom !== null
    )
      return null
    entries.push({ functionId: field.initializer, arguments: [] })
  }
  return entries
}

/** The owning constructor authenticates the implicit this passed by super(). */
export const nativeSuperInitializationOf = (
  operation: SuperInitializeOperation,
  owner: IrBody | null | undefined,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  bodyOf: (id: FunctionId) => IrBody | null | undefined,
  conversions?: Pick<ConversionCensus, 'nodeById'>
): readonly NativeInitializationEntry[] | null => {
  if (!owner) return null
  const owners = [...classes.values()].filter((layout) => layout.constructor === owner.sourceOwner)
  const layout = owners.length === 1 ? owners[0] : undefined
  if (!layout || layout.nativeBase !== null || layout.base === null || !classConstructorBodyMatches(layout, owner)) return null
  const base = classes.get(layout.base)
  return base ? nativeClassInitializationOf(base, operation.arguments, classes, bodyOf, conversions) : null
}
