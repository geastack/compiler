/**
 * Allocation provenance solved one strongly connected component at a time.
 *
 * An origin graph is cyclic wherever storage is reused. Three's
 * `WebGLRenderList.getNextRenderItem` reads `renderItems[ renderItemsIndex ]`
 * into `renderItem`, and on a miss stores a fresh literal back into
 * `renderItems` through that same `renderItem` -- so the element read's
 * origins include the very cell being proven. A depth-first proof that treats
 * a node still being visited as false refuses that pool outright; a plain
 * greatest fixpoint accepts it, but then an origin-only cycle (`a = b; b = a`,
 * which never holds any allocation at all) borrows the literal of a sibling
 * conditional branch and "proves" a value set it never had.
 *
 * The component is the unit that decides. A cycle is admitted exactly when
 * the component itself, or a proven component it depends on, contains a real
 * allocation; an unseeded cycle stays refused. A node that can only ever hold
 * `null`/`undefined` is vacuous: it contributes no allocation and refuses
 * nothing, so a reuse pool initialised to `null` still closes on the literal
 * that fills it.
 */

import ts from 'typescript'
import type { ValueFlowIndex } from './model.js'
import { dependencyComponentSolver } from './component-solver.js'

export type SeededOriginVerdict = 'refused' | 'vacuous' | 'allocated'

/**
 * `null`, the global `undefined`, or `void x`: an origin that holds no object.
 * Three's renderer starts `let currentRenderList = null` and `let _opaqueSort
 * = null`; neither empty slot can be a receiver or a callee, so it widens no
 * value set -- but it must not count as the allocation a set needs either. A
 * local binding that shadows `undefined` has a declaration and is an ordinary
 * cell instead.
 */
export const isVacuousOrigin = (flow: ValueFlowIndex, expression: ts.Expression): boolean =>
  expression.kind === ts.SyntaxKind.NullKeyword ||
  ts.isVoidExpression(expression) ||
  (ts.isIdentifier(expression) && expression.text === 'undefined' && !flow.targetOf(expression)?.declaration)

/** One provenance node as its domain expands it. */
export interface SeededOriginNode<K> {
  /** This node IS an allocation the domain accepts as a value-set root. */
  readonly seed: boolean
  /** False when the node's value set cannot be enumerated at all. */
  readonly admitted: boolean
  /** Every node whose values this node can hold. */
  readonly dependencies: readonly K[]
}

/**
 * A memoized verdict function over a lazily expanded origin graph. `expand`
 * runs once per reachable key and may record domain facts (roots, stored
 * values) as it goes: every expanded key is reachable from a queried root, and
 * a refusal anywhere on a path refuses every node above it, so an `allocated`
 * root certifies everything expanded on its behalf.
 */
/** How many origin solvers this process has built; `GEA_PROOF_STATS` prints it. */
let solversBuilt = 0
export const seededOriginSolvers = (): number => solversBuilt
export const seededOriginSolver = <K>(expand: (key: K) => SeededOriginNode<K>): ((key: K) => SeededOriginVerdict) => {
  solversBuilt++
  const solve = dependencyComponentSolver<K, never>((key) => {
    const node = expand(key)
    return { locallyComplete: node.admitted, seed: node.seed, dependencies: node.dependencies }
  }, 'seeded-origin')
  return (key) => {
    const result = solve(key)
    return result.status === 'refused' ? 'refused' : result.grounded ? 'allocated' : 'vacuous'
  }
}
