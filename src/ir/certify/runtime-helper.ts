import { representationKey } from '../../representation/model.js'
import { templateObjectCapabilityKeyOf } from '../../representation/template-object.js'
import { operandOf } from '../../semantics/model/operands.js'
import type { CapabilityDemand, CapabilityKey, CertifyContext } from '../certify.js'
import { allOperationsOf, type IrBody, type IrOperation } from '../model.js'
import {
  enumerateGetIteratorCarrierKeyOf,
  iteratorMethodCarrierKeyOf,
  regexpFlagSupportKeyOf,
  spreadSourceCarrierKeyOf
} from './carrier-keys.js'

/**
 * The `runtime-helper:*` family of `ir/certify.ts`: the iterator/spread
 * protocols, `typeof`, boolean/presence tests, allocations, destructuring's
 * shared steps, JSX elements, and the control/boundary/dynamic-language
 * forms that never refuse. Every key spelled here is exactly the string
 * `preflight/runtime-helper-key.ts`'s `runtimeHelperKey` would have spelled
 * for the SEMANTIC operation this IR operation lowers -- both draw the carrier
 * refinements from `./carrier-keys.ts` so the two censuses cannot drift, and
 * `manifest.runtimeHelpers` (`targets/cpp/manifest/capabilities.ts` plus the
 * per-program rows `manifest.ts` adds) is the one set both look the spelling
 * up in. `in`/`instanceof` are certified elsewhere (`has-property-key.ts`'s
 * and `instanceof-key.ts`'s own successors), not here.
 *
 * Unlike the old builder, this reads carriers straight off the IR operand
 * that already carries them (`IrOperand.representation`) rather than
 * re-resolving a semantic operand through the plan -- there is no plan here,
 * and none is needed: lowering already picked the exact representation every
 * consumer sees.
 */

const helper = (key: string): CapabilityDemand => ({ key: `runtime-helper:${key}` as CapabilityKey })

/**
 * The first operation of a try region's own entry block, per body.
 *
 * `boundary:exception-region` has no operation of its own to hang off -- a
 * `try` is a block-table fact (`IrBody.tryRegions`), not an instruction -- so
 * it rides along on whichever operation happens to execute first once control
 * falls into that block, the same way a line number rides on the first
 * instruction of a source line. Cached per body because `certifyIr` asks this
 * question once per OPERATION, and recomputing the whole region table for
 * every one of them would make a body with many try statements quadratic.
 */
const tryEntryFirstOperations = new WeakMap<IrBody, ReadonlySet<IrOperation>>()
const tryEntryFirstOperationsOf = (body: IrBody): ReadonlySet<IrOperation> => {
  const cached = tryEntryFirstOperations.get(body)
  if (cached) return cached
  const firstOperations = new Set<IrOperation>()
  for (const region of body.tryRegions) {
    const block = body.blocks.get(region.tryEntry)
    const first = block ? allOperationsOf(block)[0] : undefined
    if (first) firstOperations.add(first)
  }
  tryEntryFirstOperations.set(body, firstOperations)
  return firstOperations
}

/**
 * Allocation, property, and protocol operations are all reached by several
 * different IR op kinds and, for a handful of kinds, by several different
 * SEMANTIC families -- `get` is a destructuring element read, a destructuring
 * rest field copy, AND the iterator protocol's `get-method` step, all built
 * from the identical `ctx.builder.get` call. `ctx.semanticOperationOf` (the
 * SAME `SemanticOperation` `runtimeHelperKey` read `family`/`form`/`protocol`
 * off of) is what tells them apart; an op whose lineage names none of the
 * families this function knows about demands nothing here -- it is some
 * other family's ordinary property/call/binding op, censused by a sibling
 * module.
 */
const ownKindDemandsOf = (operation: IrOperation, ctx: CertifyContext): readonly CapabilityDemand[] => {
  switch (operation.kind) {
    case 'get': {
      const semantic = ctx.semanticOperationOf(operation.lineage)
      if (semantic?.family === 'protocol') {
        // `enumerate` mints no `get-method` step at all (`lower-protocol.ts`);
        // every `get` reached through the protocol family is `iterator`/`async-iterator`.
        const receiver = operation.receiver.representation
        const carrier = iteratorMethodCarrierKeyOf(receiver.kind, receiver, ctx.deriver)
        return [helper(`protocol:${semantic.protocol}:get-method:${carrier}`)]
      }
      if (semantic?.family === 'destructuring') {
        // An object-pattern element is an ordinary `[[Get]]`, censused as one
        // by the property-access family -- raising a second obligation here
        // would ask the target for a primitive it never calls.
        if (semantic.form === 'object-pattern') return []
        if (semantic.form === 'rest-element')
          return [helper(`destructuring:rest-element:object-pattern:${operation.receiver.representation.kind}`)]
        if (semantic.form === 'array-pattern') return [helper(`destructuring:array-pattern:${operation.receiver.representation.kind}`)]
      }
      return []
    }
    case 'get-iterator': {
      const semantic = ctx.semanticOperationOf(operation.lineage)
      if (semantic?.family === 'protocol') {
        const receiver = operation.receiver.representation
        const carrier =
          operation.protocol === 'enumerate'
            ? enumerateGetIteratorCarrierKeyOf(receiver.kind, receiver)
            : iteratorMethodCarrierKeyOf(receiver.kind, receiver, ctx.deriver)
        return [helper(`protocol:${operation.protocol}:get-iterator:${carrier}`)]
      }
      // The array-pattern SOURCE step's own Set/string snapshot and dynamic
      // fast paths mint this op directly; its OWN published result carrier is
      // the key, exactly as `runtimeHelperKey`'s `isSourceStep` branch reads
      // the semantic op's own result rather than its `base` operand.
      if (semantic?.family === 'destructuring' && semantic.form === 'array-pattern') {
        return [helper(`destructuring:array-pattern:${operation.result.representation.kind}`)]
      }
      return []
    }
    case 'iterator-next': {
      const semantic = ctx.semanticOperationOf(operation.lineage)
      if (semantic?.family === 'protocol') return [helper(`protocol:${semantic.protocol}:next:${operation.iterator.representation.kind}`)]
      if (semantic?.family === 'destructuring' && semantic.form === 'array-pattern') {
        return [helper(`destructuring:array-pattern:${operation.iterator.representation.kind}`)]
      }
      return []
    }
    // `IteratorResult`'s `done` half is the SAME semantic `next` step as the
    // `iterator-next` op beside it (`model.ts`'s own doc on `IteratorDoneOperation`);
    // raising the demand from both would ask twice for one capability.
    case 'iterator-done':
      return []
    case 'iterator-close': {
      const semantic = ctx.semanticOperationOf(operation.lineage)
      if (semantic?.family === 'protocol') return [helper(`protocol:${semantic.protocol}:close:${operation.iterator.representation.kind}`)]
      if (semantic?.family === 'destructuring' && semantic.form === 'array-pattern-close') {
        return [helper(`destructuring:array-pattern-close:${operation.iterator.representation.kind}`)]
      }
      return []
    }
    case 'spread-copy': {
      const semantic = ctx.semanticOperationOf(operation.lineage)
      if (semantic?.family === 'protocol' && semantic.protocol === 'spread') {
        const source = operation.source.representation
        const carrier = spreadSourceCarrierKeyOf(source.kind, source, operation.receiver.representation, ctx.deriver)
        return [helper(`protocol:spread:next:${carrier}`)]
      }
      // The dictionary half of an object-pattern rest ("{...rest}") reuses
      // object spread's own copy primitive (`lower-destructuring.ts`'s
      // `lowerObjectPatternRest`); its capability is keyed by the REST's own
      // family/form, never by "spread", so a program with no object-spread
      // capability but a dictionary rest is not falsely refused for the wrong
      // reason.
      if (semantic?.family === 'destructuring' && semantic.form === 'rest-element') {
        return [helper(`destructuring:rest-element:object-pattern:${operation.source.representation.kind}`)]
      }
      return []
    }

    // -----------------------------------------------------------------------
    // Computation
    // -----------------------------------------------------------------------
    case 'compute': {
      if (operation.nativeEquality) return [helper(`computation:strict-equality:dynamic-${operation.nativeEquality.primitive}`)]
      if (operation.form === 'require-object-coercible') return [helper('destructuring:RequireObjectCoercible')]
      if (operation.form === 'unary' && operation.operator === 'ObjectTag') {
        const operand = operation.operands[0]
        return operand ? [helper(`computation:object-tag:${representationKey(operand.representation)}`)] : []
      }
      if (operation.form === 'typeof') {
        const operand = operation.operands[0]
        return operand ? [helper(`computation:typeof:${representationKey(operand.representation)}`)] : []
      }
      // `!x` runs the same `ToBoolean` a conditional's guard runs (`test`,
      // below), censused under the identical key so a backend cannot claim
      // truthiness for one and not the other.
      if (operation.form === 'unary' && operation.operator === '!') {
        const operand = operation.operands[0]
        return operand ? [helper(`conversion:to-boolean:${operand.representation.kind}`)] : []
      }
      // `in`/`instanceof` are certified by their own successor module.
      // `binary`/`update`/`equality`/`template`/`require-iterable-present`/
      // `require-tagged-union-arm` need no runtime-helper claim: a mixed-carrier
      // coercion is now a `convert` op the spine already certifies through the
      // conversion census, and the rest are physical-carrier operations the
      // generic per-value `physical-cpp-type` check already covers.
      return []
    }

    // -----------------------------------------------------------------------
    // Boolean and presence tests
    // -----------------------------------------------------------------------
    case 'test': {
      // A test inside a proven-dead `typeof` guard's consequent never runs;
      // censusing it would refuse a program over a helper nothing evaluates.
      if (ctx.isDead(operation.lineage)) return []
      const carrier = operation.value.representation
      if (carrier.kind === 'unresolved') return []
      // A boolean needs no `ToBoolean` -- it IS the answer -- but still needs a
      // presence test like anything else, since being a boolean says nothing
      // about being absent. `is-defined` shares `is-present`'s row: both are
      // absence tests over the same carrier, just of `undefined` alone versus
      // `null`-or-`undefined`, and the backend's rendering doesn't distinguish
      // the two at the capability level -- only at which branch it takes.
      if (operation.predicate === 'to-boolean' && carrier.kind === 'scalar' && carrier.domain === 'boolean') return []
      const family = operation.predicate === 'to-boolean' ? 'to-boolean' : 'is-present'
      return [helper(`conversion:${family}:${carrier.kind}`)]
    }

    // -----------------------------------------------------------------------
    // Allocations
    // -----------------------------------------------------------------------
    case 'allocate-ordinary-object':
      return [helper(`allocation:object-literal:${operation.result.representation.kind}`)]
    case 'allocate-array-object': {
      const semantic = ctx.semanticOperationOf(operation.lineage)
      if (semantic?.family === 'allocation') {
        const dynamicGather = operation.elements.some((element) => element.kind === 'gather')
        return [helper(`allocation:array-literal:${operation.result.representation.kind}${dynamicGather ? '(dynamic-gather)' : ''}`)]
      }
      // An array-pattern rest ("[...tail]") allocates through this identical
      // primitive; its capability is the SOURCE's own carrier (what the
      // spread/gather element actually drains), matching
      // `destructuring:rest-element`'s array-shaped row rather than
      // `allocation:array-literal`'s -- see `runtime-helper-key.ts`'s own
      // doc on why the two forms must not share a key.
      if (semantic?.family === 'destructuring' && semantic.form === 'rest-element') {
        const element = operation.elements[0]
        const carrier =
          element?.kind === 'gather'
            ? element.iterator.representation.kind
            : element?.kind === 'spread'
              ? element.value.representation.kind
              : 'absent'
        return [helper(`destructuring:rest-element:${carrier}`)]
      }
      // The array-pattern SOURCE step's Set/string snapshot fast path
      // (`lowerArrayPatternSource`) also allocates through this primitive;
      // keyed by its own published result, exactly as the `get-iterator` case
      // above keys the source step's dynamic fast path.
      if (semantic?.family === 'destructuring' && semantic.form === 'array-pattern') {
        return [helper(`destructuring:array-pattern:${operation.result.representation.kind}`)]
      }
      // Every other caller (an empty-array conversion sentinel in
      // `lower-narrow.ts`, a rest-parameter pack in `lower-operands.ts`) reuses
      // this primitive for a capability already censused at its OWN site
      // (a `conversion:*`/`call-abi:*` demand) -- raising `allocation:*` again
      // here would ask for a claim nothing in the old census ever asked for.
      return []
    }
    case 'allocate-record': {
      // `allocate-record` is the one allocation op that serves two DIFFERENT
      // `allocated` buckets (an object literal's native layout and a tuple
      // array literal's) -- the semantic operation's own field is the only
      // way to tell them apart, exactly as `runtime-helper-key.ts` reads it.
      // A destructuring rest's `{...rest}` (also built through this op) is
      // deliberately excluded: its capability is raised from the sibling
      // `get`/`spread-copy` ops that carry its SOURCE carrier, which this op
      // does not.
      const semantic = ctx.semanticOperationOf(operation.lineage)
      if (semantic?.family !== 'allocation') return []
      return [helper(`allocation:${semantic.allocated}:${operation.result.representation.kind}`)]
    }
    case 'allocate-callable':
      return [helper(`allocation:function-object:${operation.result.representation.kind}`)]
    // A bound function is still a `CallableObject`-shaped allocation -- the
    // identical physical capability `allocate-callable` needs, regardless of
    // which family's lowering (a `.bind()` call, a method value read into a
    // receiver-less slot) asked for it.
    case 'bind-callable':
      return [helper(`allocation:function-object:${operation.result.representation.kind}`)]
    case 'allocate-constructor':
      return [helper(`allocation:class-constructor-object:${operation.result.representation.kind}`)]
    // Never actually lowered today (`ir/build.ts`'s `allocateProxy` has no
    // caller) -- there is consequently no OLD key to reproduce for it. Named
    // for consistency with every other allocation op, so the day a `new
    // Proxy(...)` lowering exists it certifies against a key already wired
    // rather than a silently-missing one.
    case 'allocate-proxy':
      return [helper(`allocation:proxy:${operation.result.representation.kind}`)]
    case 'allocate-regexp':
      return [helper(`allocation:regexp-object:${operation.result.representation.kind}(${regexpFlagSupportKeyOf(operation.flags)})`)]
    case 'allocate-template-object':
      // `templateObjectCapabilityKeyOf` already returns the complete,
      // prefixed key (`representationKey`, not the bare `.kind`) -- the one
      // allocation whose capability depends on the FULL structural identity
      // of its carrier, not just its outer constructor.
      return [helper(templateObjectCapabilityKeyOf(operation.result.representation))]

    // -----------------------------------------------------------------------
    // Elements
    // -----------------------------------------------------------------------
    case 'element':
      return [helper(`element:${operation.form}`)]

    // -----------------------------------------------------------------------
    // Control, boundary, dynamic-language: the manifest claims every row in
    // these three families outright (`currentCppRuntimeCapabilities`'s
    // `control:*`/`boundary:*` rows), so nothing here can ever refuse. The
    // mapping is therefore kept approximate rather than exhaustively precise:
    // `dynamic-language:*` is omitted entirely because no IR primitive lowers
    // a `dynamic-import`/`direct-eval` operation yet (any program using one
    // is refused earlier, at lowering, and never reaches this walk), and
    // `boundary:async-resume`/`boundary:generator-resume` are attributed to
    // the `await`/`yield` operation that is their actual resume point rather
    // than to a dedicated `BoundaryOperation` the old census could never
    // reach either (it publishes no result, so `buildRuntimeHelperObligation`
    // never anchored on it).
    // -----------------------------------------------------------------------
    case 'branch': {
      const semantic = ctx.semanticOperationOf(operation.lineage)
      if (semantic?.family !== 'control') return []
      // A head-tested loop is the one control form not decided by its name
      // alone: `lowerControl` builds it out of the guard's own blocks only
      // when a condition operand exists, so the key follows that same fact.
      if (semantic.form === 'loop') return [helper(operandOf(semantic, 'condition', 0) ? 'control:loop' : 'control:loop:iteration')]
      return [helper(`control:${semantic.form}`)]
    }
    case 'await':
      return [helper('control:await'), helper('boundary:async-resume')]
    case 'yield':
      return [helper('control:yield'), helper('boundary:generator-resume')]
    case 'return':
      return [helper('control:return')]
    case 'throw':
      return [helper('control:throw')]
    case 'switch':
      return [helper('control:switch')]
    default:
      return []
  }
}

export const runtimeHelperKeysOf = (operation: IrOperation, ctx: CertifyContext): readonly CapabilityDemand[] => {
  const demands = ownKindDemandsOf(operation, ctx)
  return tryEntryFirstOperationsOf(ctx.body).has(operation) ? [...demands, helper('boundary:exception-region')] : demands
}
