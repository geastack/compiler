import ts from 'typescript'
import type { ValueFlowIndex } from './model.js'

/**
 * Whether the program writes a value into this method's own slot -- three's
 * `Node.onUpdate`: `this.update = callback`, or `C.prototype.m = fn`.
 *
 * Such a method is one of several functions a call through the slot reaches,
 * so its own body is not evidence for what the slot returns. Every census that
 * reads a call's result off the callee's `return`s asks this first; a
 * `return` inside the body is recorded against the same declaration (the
 * return cell), which is not a write to the slot.
 */
export const methodSlotIsWritten = (flow: ValueFlowIndex, declaration: ts.Node): boolean =>
  ts.isMethodDeclaration(declaration) &&
  flow.writesToDeclaration(declaration).some((write) => write.value !== null && write.edge !== 'return' && write.edge !== 'yield')
