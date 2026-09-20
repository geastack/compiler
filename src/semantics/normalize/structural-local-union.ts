import ts from 'typescript'
import type { StructuralTypeId } from '../../identity/ids.js'
import type { StructuralTypeTable } from '../model/structural-type-table.js'
import type { ValueFlowIndex } from './flow/model.js'
import type { ParameterBindingCensus } from './parameter-bindings.js'
import { containsUnstatedPosition } from './derived-expression-type.js'

/**
 * Complete a synthesized local union in the SAME specialization view as its
 * writes. A ts.Type member list can still contain erased positions (Function
 * inside a parameter tuple); the source expression's structural type already
 * has their physical callable signatures. Storing that value must not erase it
 * back to Function. The flow index supplies every write, never a syntax scan.
 */
export const createLocalUnionResolver = (
  checker: ts.TypeChecker,
  table: StructuralTypeTable,
  census: ParameterBindingCensus,
  flow: ValueFlowIndex | undefined,
  read: (node: ts.Node) => StructuralTypeId,
  refinedSourceAt: (node: ts.Node) => StructuralTypeId | null = () => null
): ((node: ts.Node) => StructuralTypeId | null) => {
  const memo = new Map<ts.VariableDeclaration, StructuralTypeId | null>()
  const pending = new Set<ts.VariableDeclaration>()
  const sourceRefined = new Set<ts.VariableDeclaration>()
  const concreteRefinement = (id: StructuralTypeId, visited = new Set<StructuralTypeId>()): boolean => {
    if (visited.has(id)) return true
    visited.add(id)
    const shape = table.get(id).shape
    if (shape.kind === 'primitive') return shape.primitive !== 'any' && shape.primitive !== 'unknown'
    if (shape.kind === 'union') return shape.members.every((member) => concreteRefinement(member, visited))
    if (shape.kind === 'object') return shape.members.every((member) => concreteRefinement(member.type, visited))
    return shape.kind !== 'unresolved'
  }
  const resolve = (declaration: ts.VariableDeclaration): StructuralTypeId | null => {
    if (!flow || declaration.type || !ts.isIdentifier(declaration.name)) return null
    if (memo.has(declaration)) return memo.get(declaration) ?? null
    if (pending.has(declaration)) return null
    const writes = flow.writesToDeclaration(declaration).filter((write) => write.slot === 'whole')
    if (
      !writes.length ||
      writes.some((write) => !write.value || (write.edge !== 'declaration-initializer' && write.edge !== 'identifier-assignment'))
    )
      return null
    // Some authenticated intrinsic calls publish a more precise structural
    // result than their non-generic ambient signature. Its unannotated local
    // must retain that same carrier. Reuse the complete write set, requiring
    // every incoming source to establish the identical concrete refinement;
    // one unknown or incompatible writer prevents partial narrowing.
    pending.add(declaration)
    const unionArms = census.unionArmsAt(declaration)
    if (!unionArms) {
      const refinements = writes.map((write) => refinedSourceAt(write.value as ts.Expression))
      const first = refinements[0]
      if (!first || refinements.some((id) => id !== first) || !concreteRefinement(first)) {
        pending.delete(declaration)
        return null
      }
      sourceRefined.add(declaration)
    }
    const members = writes.map((write) => read(write.value as ts.Expression))
    pending.delete(declaration)
    // An uninitialized lexical binding holds undefined until its first write.
    if (!declaration.initializer) members.push(table.intern({ kind: 'primitive', primitive: 'undefined' }))
    const result = table.intern({ kind: 'union', members })
    memo.set(declaration, result)
    return result
  }
  return (node) => {
    if (ts.isVariableDeclaration(node)) return resolve(node)
    if (!ts.isIdentifier(node)) return null
    const declarations = checker.getSymbolAtLocation(node)?.declarations
    const declaration = declarations?.length === 1 ? declarations[0] : undefined
    if (!declaration || !ts.isVariableDeclaration(declaration)) return null
    // Resolve the narrow candidate before asking the checker for this read's
    // potentially enormous instantiated type. Almost every identifier is not
    // such a candidate; querying all of them overflowed TypeScript's own
    // conditional-type instantiation stack on Hono's route types.
    const result = resolve(declaration)
    if (!result || node === declaration.name) return result
    // Calling a union-held local does not first convert the cell into the
    // checker's common signature. The callable value remains whichever arm
    // was stored, and [[Call]] dispatches through that arm's own convention.
    // Preserve the physical union at the direct callee site so the invocation
    // lowering can perform its existing per-arm dispatch, including dropping
    // arguments for a zero-parameter arm. Any non-callable or incompatible
    // arm still fails closed in that lowering.
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) return result
    const raw = checker.getTypeAtLocation(node)
    // `Array.isArray(local)` deliberately narrows the true branch to `any[]`,
    // even when this census already knows the local's sole array write arm and
    // its concrete element type. The predicate selects that existing arm; it
    // neither allocates a new Array<any> nor converts the elements. Recover it
    // from the physical write union when exactly one array carrier is possible.
    // A union with two array arms remains ambiguous and keeps the checker's
    // view, as does a genuinely declared any[] cell whose physical shape is
    // already just that array.
    if (checker.isArrayType(raw)) {
      const [element] = checker.getTypeArguments(raw as ts.TypeReference)
      const shape = table.get(result).shape
      if (element && (element.flags & ts.TypeFlags.Any) !== 0 && shape.kind === 'union') {
        const arrays = shape.members.filter((id) => table.get(id).shape.kind === 'array')
        if (arrays.length === 1) return arrays[0] ?? null
      }
    }
    // A real flow narrowing keeps its own type. An erased Function/any at a
    // read is not such a narrowing, but may still prove nullish exclusion.
    if (!sourceRefined.has(declaration) && !containsUnstatedPosition(checker, node, raw)) return null
    if ((raw.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return result
    if ((raw.flags & ts.TypeFlags.Undefined) !== 0) return table.intern({ kind: 'primitive', primitive: 'undefined' })
    if ((raw.flags & ts.TypeFlags.Null) !== 0) return table.intern({ kind: 'primitive', primitive: 'null' })
    const shape = table.get(result).shape
    if (shape.kind !== 'union') return result
    const rawMembers = raw.isUnion() ? raw.types : [raw]
    const allows = (flag: ts.TypeFlags): boolean => rawMembers.some((member) => (member.flags & flag) !== 0)
    const kept = shape.members.filter((id) => {
      const member = table.get(id).shape
      if (member.kind !== 'primitive') return true
      if (member.primitive === 'undefined') return allows(ts.TypeFlags.Undefined)
      if (member.primitive === 'null') return allows(ts.TypeFlags.Null)
      return true
    })
    return kept.length === 1 ? (kept[0] ?? null) : table.intern({ kind: 'union', members: kept })
  }
}
