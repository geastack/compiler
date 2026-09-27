import ts from 'typescript'
import type { ValueFlowIndex } from './flow/model.js'

/**
 * Whether this read of an unannotated local sees the cell as it is STORED,
 * not as the checker typed it.
 *
 * The checker keeps a `let`'s declared type at a read when a later write is
 * not assignable to it. That is not a narrowing: the checker ignored the
 * write. three's WebGLAttributeUtils.createAttribute writes
 * `let attributeData = { ... }`, then under a guard
 * `attributeData = new DualAttributeData( attributeData, dual )`, then reads
 * `backend.set( attribute, attributeData )`. The checker says the record at
 * that read, while the value may be the DualAttributeData.
 *
 * A read the checker did not narrow (its type there IS the declared type),
 * placed after every whole-cell write, may see any of them, so it reads the
 * census's stored union. The stored union is always a sound answer; the order
 * only keeps precision. A read before a write, or inside one's right-hand
 * side (the `attributeData` passed to `new DualAttributeData`), keeps the
 * checker's answer.
 *
 * The one authority for this rule. Asked where the read's layout is decided
 * (`structural-local-union.ts`) and where a parameter census takes the type
 * of an argument (`parameter-bindings.ts`), so both see the same value. The
 * caller checks that its census holds a synthesized union for the cell.
 */
export const readFollowsEveryWrite = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  declaration: ts.VariableDeclaration,
  read: ts.Identifier
): boolean => {
  if (declaration.type || !ts.isIdentifier(declaration.name) || read === declaration.name) return false
  if (checker.getTypeAtLocation(read) !== checker.getTypeAtLocation(declaration.name)) return false
  const writes = flow.writesToDeclaration(declaration).filter((write) => write.slot === 'whole')
  return writes.length > 0 && writes.every((write) => write.value !== null && write.value.end <= read.pos)
}
