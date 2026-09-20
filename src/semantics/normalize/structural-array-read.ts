import ts from 'typescript'
import type { StructuralTypeId } from '../../identity/ids.js'
import type { StructuralTypeTable } from '../model/structural-type-table.js'
import { containsUnstatedPosition } from './derived-expression-type.js'

/** Read an erased indexed type from the receiver's actual structural layout.
 * A parameter census can refine [Function][] to a native callable tuple array.
 * Asking the checker again for a[i][0] loses that refinement at each index.
 * Real checker narrowings remain authoritative; this only fills unstated slots.
 * The checker can also report `never` for a read from an evolving empty-array
 * literal after the receiver itself has been recovered as a usable array. In
 * that case the receiver layout is the evidence for the read; an actual
 * `never[]` remains `never` because its recovered element is also `never`.
 */
export const structuralArrayReadAt = (
  checker: ts.TypeChecker,
  table: StructuralTypeTable,
  source: StructuralTypeId | null,
  node: ts.Node
): StructuralTypeId | null => {
  if (!source || !ts.isElementAccessExpression(node) || node.questionDotToken) return null
  const raw = checker.getTypeAtLocation(node)
  const key = node.argumentExpression
  const index = ts.isNumericLiteral(key) || ts.isStringLiteralLike(key) ? Number(key.text) : null
  const numeric =
    index !== null
      ? Number.isInteger(index) && index >= 0 && (ts.isNumericLiteral(key) || (ts.isStringLiteralLike(key) && String(index) === key.text))
      : (checker.getTypeAtLocation(key).flags & ts.TypeFlags.NumberLike) !== 0
  const symbol = (checker.getTypeAtLocation(key).flags & ts.TypeFlags.ESSymbolLike) !== 0
  if (!numeric && !symbol) return null
  /**
   * The type this position reads, and whether the SHAPE proves the read
   * present.
   *
   * `present` is not a second opinion about the type -- it is the same walk
   * reporting which of its branches ended on a position the shape says always
   * exists: a non-optional position of a CLOSED tuple, or a position before an
   * open tuple's rest. Those cannot be out of range and cannot hold a hole, so
   * the `admitsUndefined` recovery below (right for an array, whose length
   * nothing here knows) must not put an absence back that this walk just ruled
   * out. Everything else -- an array element, a union with any unproven arm, an
   * optional position -- reports `false` and is treated exactly as before.
   */
  const visit = (id: StructuralTypeId, seen: ReadonlySet<StructuralTypeId>): { id: StructuralTypeId; present: boolean } | null => {
    if (seen.has(id)) return null
    const next = new Set(seen).add(id)
    const shape = table.get(id).shape
    if (shape.kind === 'declared') return shape.body ? visit(shape.body, next) : null
    if (shape.kind === 'object-anchor') return visit(shape.body, next)
    if (shape.kind === 'object' && symbol) {
      const indexed = shape.index.find((entry) => entry.key === 'symbol')
      return indexed ? { id: indexed.value, present: false } : null
    }
    if (shape.kind === 'array' && numeric) return { id: shape.element, present: false }
    if (shape.kind === 'tuple' && numeric) {
      // An open-ended tuple is carried as an array of the union of its
      // positions (`derive.ts`'s `deriveTuple`); a position before the rest
      // still reads its own stated type, and any other index reads the union.
      const open = shape.elements.findIndex((element) => element.rest || element.variadic)
      if (open >= 0) {
        if (shape.elements.some((element) => element.variadic)) return null
        const fixed = index !== null && index < open ? shape.elements[index] : undefined
        if (fixed && !fixed.optional) return { id: fixed.type, present: true }
        return { id: table.intern({ kind: 'union', members: shape.elements.map((element) => element.type) }), present: false }
      }
      if (index === null) return null
      const element = shape.elements[index]
      if (!element) return null
      return element.optional
        ? {
            id: table.intern({ kind: 'union', members: [element.type, table.intern({ kind: 'primitive', primitive: 'undefined' })] }),
            present: false
          }
        : { id: element.type, present: true }
    }
    if (shape.kind === 'union') {
      const members = shape.members.map((member) => visit(member, next))
      if (members.some((member) => member === null)) return null
      const answers = members as { id: StructuralTypeId; present: boolean }[]
      return {
        id: table.intern({ kind: 'union', members: answers.map((member) => member.id) }),
        present: answers.every((member) => member.present)
      }
    }
    return null
  }
  const answer = visit(source, new Set())
  if (!answer) return null
  const result = answer.id
  const isNever = (id: StructuralTypeId, seen: ReadonlySet<StructuralTypeId>): boolean => {
    if (seen.has(id)) return false
    const next = new Set(seen).add(id)
    const shape = table.get(id).shape
    if (shape.kind === 'primitive') return shape.primitive === 'never'
    return shape.kind === 'declared' && shape.body ? isNever(shape.body, next) : false
  }
  const staleNever = (raw.flags & ts.TypeFlags.Never) !== 0 && !isNever(result, new Set())
  if (!containsUnstatedPosition(checker, node, raw) && !staleNever) return null
  // `any | undefined` collapses to `any` in the checker, so recovering its
  // element must also recover the absence that erasure hid. No checker
  // narrowing proves this read present. Otherwise a valid out-of-range
  // JavaScript read becomes ArrayObject::elementAt's native abort.
  //
  // Except where the walk above PROVED the position present. `children[0]` on
  // `/** @type {[Object3D]} */` is the case: the tuple branch answers
  // `Object3D` because position 0 of a closed 1-tuple is not optional, and then
  // this recovery unioned `undefined` straight back in because the checker's
  // own answer for the read is `any` -- one rule undoing the other, and the
  // emitted read paying for it with a presence test and an `Optional` round
  // trip on a recursive hot path (`recursive-derived-parameter-access.runtime.js`
  // pins that it does not). A shape that says the position always exists is not
  // an erasure to recover from.
  const admitsUndefined =
    !answer.present &&
    (raw.isUnion() ? raw.types : [raw]).some(
      (arm) => (arm.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
    )
  return admitsUndefined
    ? table.intern({ kind: 'union', members: [result, table.intern({ kind: 'primitive', primitive: 'undefined' })] })
    : result
}
