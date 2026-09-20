import { thrownValueCarrier } from '../representation/model.js'
import type { BoundaryOperation } from '../semantics/model/operations.js'
import { IrLoweringBlockedError } from './lower-graph.js'
import { registerResult, requireLineage, requireResultRepresentation, type LoweringContext } from './lower-operands.js'
import type { IrBlockId } from './model.js'

/**
 * The one carrier a value travels in between a `throw` and the handler that
 * catches it.
 *
 * It has to be a single fixed carrier, and not either side's own idea of one,
 * because the two sides cannot see each other: a `throw` in one function is
 * caught by a `catch` in another, and a native C++ handler catches by TYPE. A
 * `throw` that emitted its operand's own static carrier and a handler that
 * named a different one produced C++ that compiled cleanly and could not
 * catch the exception at all -- `throw v0;` of a `std::string` against
 * `catch (const gea::Value& v1)` -- so the exception escaped the handler the
 * source program wrote and reached `std::terminate`. That is the silent
 * miscompile this constant exists to make impossible; `renderTryRegion`
 * (`targets/cpp/emit-exceptions.ts`) checks the handler agrees rather than
 * assuming it.
 *
 * `dynamic` is the honest answer rather than a shortcut around the no-boxing
 * rule: `'thrown-error-carrier'` is one of the four `DynamicReason`s
 * `representation/model.ts` admits, declared there from the start as "a
 * thrown value, which JavaScript does not type", and
 * `producers/boundary.ts` already says in so many words that it publishes the
 * checker's own `unknown` precisely so "a later layer" can choose this
 * carrier. This is that layer. Nothing inside the `try` is boxed by this: the
 * conversion happens at the `throw` itself, which is exactly where
 * ECMAScript loses the type too.
 *
 * The catch side needs no conversion in the other direction. TypeScript
 * admits only `any` or `unknown` on a catch parameter (`unknown` under
 * `useUnknownInCatchVariables`, which `program.ts` enables), so the caught
 * binding's own carrier is already this one physically -- what differs is the
 * stated reason, not the storage.
 */
export { thrownValueCarrier }

/**
 * `try`/`catch` and the `await`/`yield` resume points: the boundary forms this
 * backend lowers.
 *
 * `label-target` is not reached here yet: `switch`/`label` both refuse by name
 * in `lower.ts`'s `lowerControl`, before any operation gated on one of those
 * boundaries could ever be scheduled. `generator-resume` IS reached, and is a
 * no-op for the reason its own case states, as is `finally-region`.
 */
export const lowerBoundary = (ctx: LoweringContext, block: IrBlockId, operation: BoundaryOperation): void => {
  switch (operation.boundary) {
    case 'generator-resume':
      // Where control resumes after a `yield`. The C++20 coroutine transform
      // owns the resume point itself -- `co_yield` IS the suspend and the
      // resume, and control simply continues after it -- so there is no block
      // for this boundary to open. Its `value` result is never cited either:
      // `producers/control.ts` refuses a `yield` whose own value is read, so
      // nothing in the body can name what a resume would have carried. Handled
      // exactly as `async-resume` below is, and for the same reason.
      return
    case 'async-resume':
      // Where control "resumes" after an `await` -- but this backend's
      // `await` never suspends (see `lowerControl`'s `'await'` case), so
      // control already fell straight through here. Its `value` result is
      // never cited by anything either (`await x`'s consumers cite the
      // `await` operation's own result), so nothing to register.
      return
    case 'finally-region':
      // The marker whose SCOPE the gating walk hangs the finally clause's own
      // operations on (`gating.ts`'s `part: 'finally'`); the flow controller
      // opens that scope's block from the membership alone. There is nothing
      // for the marker itself to compute, and it publishes no result: a finally
      // clause is a statement list, not a value, and unlike `exception-region`
      // it binds nothing either -- the caught value belongs to `catch`.
      return
    case 'label-target':
      // A labelled iteration resolves directly to its loop's exit/header;
      // this boundary remains only for a non-iteration labelled statement,
      // whose transfer lowering will refuse if a program actually targets it.
      return
    case 'exception-region': {
      // A bindingless `catch {}` publishes no result: nothing in this body
      // ever needs the caught value, so there is nothing to materialize. The
      // emitter renders the handler as a bare `catch (...)` from the block's
      // presence in `IrBody.tryRegions` alone.
      if (operation.results.length === 0) return
      const lineage = requireLineage(operation)
      const representation = requireResultRepresentation(ctx, operation, 'value', 'an exception region')
      registerResult(ctx, operation, ctx.builder.catchBinding(block, lineage, representation))
      return
    }
    default:
      throw new IrLoweringBlockedError(`no IR primitive lowers a "${operation.boundary}" boundary yet`)
  }
}
