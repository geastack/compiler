import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type Representation, type TaggedUnionArm } from '../representation/model.js'
import type { SemanticOperand } from '../semantics/model/operands.js'
import { narrowingReachesTarget } from './build.js'

/**
 * A use can narrow a published sum without changing what its producer returns.
 * In `(query() as string[]).join(',')`, erasure correctly cites the call's
 * result, but the receiver operand still states the asserted array type. The
 * load of that arm must be explicit before invoking its native internal method.
 * Only an existing payload can be selected here: this never boxes, reconstructs
 * a table, changes a call ABI, or treats an unrelated assertion as a cast.
 * Preflight checks the resulting pair against the conversion graph; lowering
 * emits the same pair as an IR conversion.
 */
export const narrowedOperandView = (source: Representation, operand: SemanticOperand, deriver: RepresentationDeriver): Representation => {
  // A box asserted to a type (`(value as string[]).join(',')` over an `any`)
  // is read as that type: the checked unbox, then the native member. Read off
  // the box, the member was looked up as a detached function value and
  // called with no receiver.
  if (source.kind === 'dynamic' && operand.asserted === true) {
    const asserted = deriver.derive(operand.type)
    return asserted.kind === 'unresolved' ? source : asserted
  }
  // A base class handle asserted to a descendant (`(base as Derived).b`, `b`
  // declared only on `Derived`; `properties.ts`'s
  // `assertsDescendantClassOfUnionArm`): the member lives on the descendant, so
  // the receiver is read as it -- the census's checked class-descendant
  // downcast, a named abort when the object is not one.
  if (source.kind === 'class-ref' && operand.asserted === true) {
    const asserted = deriver.derive(operand.type)
    return asserted.kind === 'class-ref' && representationKey(asserted) !== representationKey(source) ? asserted : source
  }
  if (source.kind !== 'optional' && source.kind !== 'tagged-union') return source
  const target = deriver.derive(operand.type)
  if (representationKey(source) === representationKey(target)) return source
  if (source.kind === 'tagged-union' && source.arms.some(isProxyArm)) return narrowedKeepingProxies(source, target)
  // The same sum behind an absence -- a module `let` with no initializer, read
  // where it may still be unwritten (`representation/unassigned-binding-cells.ts`):
  // mongodb's `'kModuleError' in zstd` over the proxy-carrying `ZStandard`. A
  // use that states the arm ran on a present value (`in` throws on
  // `undefined`, and so does a member read), so the view is the payload's own
  // proxy-keeping selection -- the payload itself when the checker's arm is
  // every ordinary arm it holds -- reached by the checked presence load.
  if (source.kind === 'optional' && source.payload.kind === 'tagged-union' && source.payload.arms.some(isProxyArm)) {
    const payload = source.payload
    const wanted = (target.kind === 'tagged-union' ? target.arms.map((arm) => arm.value) : [target]).map(representationKey)
    const ordinary = new Set(payload.arms.filter((arm) => !isProxyArm(arm)).map((arm) => representationKey(arm.value)))
    if (wanted.length > 0 && wanted.every((key) => ordinary.has(key))) return narrowedKeepingProxies(payload, target)
  }
  return narrowingReachesTarget(source, target) ? target : source
}

const isProxyArm = (arm: TaggedUnionArm): boolean => arm.value.kind === 'proxy-object'

/**
 * A proxy answers `in`, `typeof`-free structural checks and every other
 * narrowing test through its own traps, so no narrowing the checker performed
 * can rule it out: a narrowed view of a sum holding a proxy arm keeps that arm
 * (under its own tag) beside the ordinary arms the narrowing selected. Loading
 * the narrowed arm unchecked would read the wrong payload while the proxy is
 * the one held.
 */
const narrowedKeepingProxies = (source: Representation & { kind: 'tagged-union' }, target: Representation): Representation => {
  const ordinary = source.arms.filter((arm) => !isProxyArm(arm))
  const wanted = new Set(
    (target.kind === 'tagged-union' ? target.arms.map((arm) => arm.value) : [target]).map((value) => representationKey(value))
  )
  const kept = ordinary.filter((arm) => wanted.has(representationKey(arm.value)))
  if (kept.length === 0 || kept.length !== wanted.size || kept.length === ordinary.length) return source
  return { kind: 'tagged-union', arms: [...kept, ...source.arms.filter(isProxyArm)] }
}
