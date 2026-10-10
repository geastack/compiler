import type { ConversionCensus } from '../conversion/nodes.js'
import type { DeclarationId, FunctionId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { virtualDispatchVerdictOf } from '../projection/dispatch.js'
import type { CallableAbi } from '../representation/model.js'
import { capturesNothing } from './captures.js'
import type { IrBody } from './model.js'

/** The virtual members generated from the final native bodies and allocation layouts. */
export const settledVirtualCallFramesOf = (
  bodies: Iterable<IrBody>,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  conversions: ConversionCensus
): ReadonlyMap<string, CallableAbi> => {
  const byOwner = new Map([...bodies].map((body) => [String(body.sourceOwner), body]))
  const verdict = virtualDispatchVerdictOf(
    classes,
    (callable: FunctionId) => byOwner.get(String(callable))?.abi ?? null,
    (callable) => capturesNothing(byOwner.get(String(callable))?.facts),
    conversions
  )
  return new Map([...verdict.dispatched].map(([key, family]) => [key, family.rootAbi]))
}
