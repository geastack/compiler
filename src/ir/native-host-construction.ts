import type { ConversionCensus } from '../conversion/nodes.js'
import { representationKey, type CallableAbi } from '../representation/model.js'
import { hostConstructFrameOf, nativeArgumentsMatch } from './call-entry.js'
import type { ConstructOperation } from './model.js'

/**
 * A construction through a host constructor whose frame is native end to end,
 * or `null`.
 *
 * The rule the reflection census already applies to a sealed native call --
 * the exact frame is the whole proof -- applied to `[[Construct]]`. Every
 * received argument reaches its formal in native storage, so none is
 * published as a `gea::Value`; and the result is a FRESH host object the
 * construction mints in the carrier this site holds, so it publishes no
 * object that existed before it. What the program later reads or writes
 * through the new collection is a `get`/`set`/call of its own and is censused
 * there, the same way a closed call's result is.
 *
 * three.js is the shape this exists for. `WebGLProperties` holds every
 * texture/material/render-target bag in `new WeakMap()`, `WebGLRenderStates`
 * its per-scene state arrays in `new Map()`, `WebGLShaderCache`,
 * `WebGLGeometries`, `WebGLMorphtargets`, `WebGLTextures` and
 * `WebGLObjects` the same. None of these callees states a construct
 * convention (`native-handle(...;construct=-)`): their overload sets join
 * into none, correctly. So each construction read as unknown and published
 * the collection's key and value carriers -- the full field protocol of every
 * record those caches hold -- while the emitted C++ was a bare
 * `gea::makeRef<...>()`. The site's own frame comes from the overload the
 * checker selected there (`ConstructOperation.hostFrame`); a handle that
 * does join (`ErrorConstructor`'s `(message?: string, options?)`) is asked for
 * its own convention, under which `new Error("...")`'s string argument
 * reaches the `string | undefined` formal through the census's native
 * optional injection.
 *
 * Why not `nativeCallFrameOf` (call-entry.ts): it confirms the frame against
 * the convention the callee VALUE states through `abiOfCallee`, and a
 * `native-handle` states only `construct` -- null exactly where this is
 * needed. The argument half is the same `nativeArgumentsMatch` under the same
 * `native-transfer` proof, and the receiver half has nothing to check: a
 * construction's receiver is the object it allocates.
 *
 * Refused, and left to the unknown-construction boundary:
 * - a callee that is not a bare `native-handle` -- `new this.constructor()`
 *   in three's `clone()` bodies holds a `dynamic[]`-rest constructor value;
 *   that is genuinely dynamic and belongs to the class paths, not here;
 * - a construction whose new-target is not its own callee, which emission
 *   refuses as well (`emitConstruct`);
 * - a rest frame, which this does not pack;
 * - a `dynamic` result -- `new Proxy(...)` and `new Function(...)`, the two
 *   host constructions whose renderers box their arguments into the result;
 * - a result carrier that is not the frame's, where the construction would
 *   first mint one object and then convert it;
 * - any argument the census does not carry natively into its formal.
 */
export const nativeHostConstructionOf = (
  operation: ConstructOperation,
  conversions?: Pick<ConversionCensus, 'nodeById'>
): CallableAbi | null => {
  // The frame itself has one authority, shared with the census that publishes
  // this construction's omitted-formal conversions.
  const abi = hostConstructFrameOf(operation)
  if (abi === null || abi.receiver !== null || abi.restFrom !== null) return null
  const result = operation.result.representation
  if (result.kind === 'dynamic' || representationKey(result) !== representationKey(abi.result)) return null
  return nativeArgumentsMatch(abi, operation.arguments, conversions, 'native-transfer') ? abi : null
}
