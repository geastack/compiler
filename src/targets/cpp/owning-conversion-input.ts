import type { IrOperand } from '../../ir/model.js'
import type { Representation } from '../../representation/model.js'
import type { EmitContext } from './emit-context.js'
import { movedValueText } from './emit-narrowing.js'

/** The string-to-dynamic recipe constructs one owned payload from its input.
 * Moving the finished conversion is too late: its static_cast<std::string>
 * already copied the input. Transfer a dying input into that same certified
 * recipe instead. This changes ownership, never which conversion is selected.
 *
 * Do not generalize this to arbitrary recipes: sum classification, structural
 * projection and user-visible conversions may inspect their input repeatedly.
 * Use the same liveness/physical-storage proof as ordinary moves: deferred
 * expressions and values needed by later iterations cannot be donated, and
 * a const borrowed formal still copies when bound to the owning payload. */
export const owningConversionInputText = (ctx: EmitContext, source: IrOperand, target: Representation, text: string): string =>
  source.representation.kind === 'string' && target.kind === 'dynamic' ? movedValueText(ctx, source, source.representation, text) : text
