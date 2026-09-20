import type ts from 'typescript'
import type { ParameterBindingCensus } from './parameter-bindings.js'
import { sameImplicitArgumentsTuple, type ImplicitArgumentsTuple } from './implicit-arguments-tuple.js'

type CensusFact = ts.Type | ts.Node | readonly (ts.Type | ts.Node)[] | ImplicitArgumentsTuple | null

/** A frame fact is a fresh object each round; it settles when it states the same frame, not when it is the same object. */
const isFrameFact = (fact: CensusFact): fact is ImplicitArgumentsTuple => fact !== null && !Array.isArray(fact) && 'frame' in fact
type FactQuery = {
  [K in keyof ParameterBindingCensus]-?: NonNullable<ParameterBindingCensus[K]> extends (node: never) => CensusFact ? K : never
}[keyof ParameterBindingCensus]

// Derive the keys from the public census interface. A new fact query must be
// included here or TypeScript rejects the build; it cannot escape convergence.
const queries: Record<FactQuery, (view: ParameterBindingCensus, node: ts.Node) => CensusFact> = {
  argumentsAt: (view, node) => view.argumentsAt?.(node as ts.ParameterDeclaration) ?? null,
  callTargetsAt: (view, node) => view.callTargetsAt?.(node as ts.CallExpression | ts.NewExpression) ?? null,
  callDeclarationAt: (view, node) => view.callDeclarationAt?.(node as ts.CallExpression | ts.NewExpression) ?? null,
  typeAt: (view, node) => view.typeAt(node),
  implicitArgumentsTupleAt: (view, node) => view.implicitArgumentsTupleAt?.(node) ?? null,
  restElementTypeAt: (view, node) => view.restElementTypeAt?.(node as ts.ParameterDeclaration) ?? null,
  statedTypeAt: (view, node) => view.statedTypeAt(node),
  unionArmsAt: (view, node) => view.unionArmsAt(node),
  preferredTypeAt: (view, node) => view.preferredTypeAt?.(node) ?? null,
  patternReadTypeAt: (view, node) => view.patternReadTypeAt?.(node as ts.BindingElement) ?? null
}

/**
 * One round's whole output: the parameter census the fixpoint settles on, and
 * every other artifact that round produced.
 *
 * `facts` is generic because this module settles a fixpoint and has no business
 * knowing which censuses a round happens to build. What matters is that a round
 * RETURNS them. They used to be published by assigning to `let`s captured from
 * the enclosing scope, which made `compose` a function that answered one
 * question and silently republished four more -- so "which round's collection
 * census does the structural mapper read" was answered by the last write to
 * survive the loop rather than by anything a reader could see. That is the same
 * two-authorities shape this refactor removes everywhere else
 * (the frontend's evidence-policy tables).
 */
export interface RoundCensus<Facts> {
  readonly parameters: ParameterBindingCensus
  readonly facts: Facts
}

/** A settled `RoundCensus`, and which round settled it. */
export interface CensusSnapshot<Facts> extends RoundCensus<Facts> {
  readonly round: number
}

/**
 * Count equality cannot establish a fixed point: a cell may change carrier
 * while another loses its answer. Record the actual census queries a round
 * depends on, then require its output to answer those queries identically.
 * Type identity is the checker's identity, never a rendered name or a second
 * structural-type classifier. Union lists compare their ordered type identities.
 *
 * The returned snapshot is the SETTLING round's own, in full -- not merely its
 * parameter census. Every artifact in it was built by one round from one
 * upstream view, so a consumer cannot pair a census from one round with a flow
 * index from another.
 */
export const settleBindingCensus = <Facts>(
  compose: (upstream?: ParameterBindingCensus) => RoundCensus<Facts>,
  limit = 64
): CensusSnapshot<Facts> => {
  // Carry only the `ParameterBindingCensus` forward between rounds, never the
  // whole `RoundCensus`. For the real caller (`frontend.ts`) `RoundCensus.facts`
  // holds that round's `ValueFlowIndex`, and `sourceValueSessionOf`
  // (flow/source-value-session.ts) memoizes an ~80,000-state, ~14.7M-edge
  // dependency graph in a WeakMap keyed on that index object -- roughly 1GB
  // live per session on the three.js app. A `let round: RoundCensus<Facts>` reassigned
  // only after `compose` returns keeps the PREVIOUS round's index (and its
  // graph) reachable for the whole duration of the `compose` call that builds
  // the NEXT round's index, so both graphs are live at once: measured as
  // the three.js app's ~2.1GB fixpoint peak. Only `.parameters` is ever read back out of
  // a settled round (to seed the next round's `observed` view and to compare
  // `boundCount`), so only `.parameters` needs to survive the boundary.
  let previousCensus = compose().parameters
  let unsettled: string[] = []
  const identities = new Map<ts.Type, number>()
  const factLabel = (fact: CensusFact): string => {
    if (fact === null) return 'null'
    if (Array.isArray(fact)) return `[${fact.map((type) => factLabel(type)).join(',')}]`
    if (isFrameFact(fact)) {
      return fact.frame === 'array'
        ? `arguments-array(${factLabel(fact.element)})`
        : `arguments-tuple(${fact.required}/${fact.elements.map((type) => factLabel(type)).join(',')})`
    }
    if ('kind' in fact) return `declaration:${fact.kind}`
    const type = fact as ts.Type
    if (!identities.has(type)) identities.set(type, identities.size + 1)
    return `${identities.get(type)}:${type.flags}:${type.symbol?.name ?? '-'}`
  }
  for (let rounds = 2; rounds <= limit; rounds += 1) {
    const reads = new Map<FactQuery, Map<ts.Node, CensusFact>>()
    const read = <T extends CensusFact>(name: FactQuery, node: ts.Node, value: T): T => {
      let nodes = reads.get(name)
      if (!nodes) {
        nodes = new Map()
        reads.set(name, nodes)
      }
      nodes.set(node, value)
      return value
    }
    // Bind THIS round's upstream to a fresh per-iteration const. Every round's
    // `observed` wrapper closes over the view it forwards to, and those
    // wrappers outlive their round: a census composed in round N keeps round
    // N's `observed` as its own upstream, and asks it again whenever a later
    // round consults round N's answers. Reading the carried `previousCensus`
    // variable from inside the wrapper instead pointed EVERY round's wrapper
    // at whatever the variable held last, so once it advanced to round N's
    // census, round N-1's wrapper forwarded into round N, whose upstream is
    // that same wrapper -- `statedTypeAt` recursed between the two until the
    // stack died, 58s into a three.js compile.
    const upstream = previousCensus
    const observed = { ...upstream }
    // `Object.keys` preserves the closed query table's keys. The wrapper
    // preserves each method's result kind and normalizes an absent optional
    // method to the same null answer used when checking the next view.
    for (const name of Object.keys(queries) as FactQuery[]) {
      Object.defineProperty(observed, name, {
        value: (node: ts.Node) => read(name, node, queries[name](upstream, node)),
        enumerable: true
      })
    }
    const previousBoundCount = upstream.boundCount
    // `compose` is called with nothing in this function's own scope naming the
    // previous round's `facts` -- `observed` closes over `previousCensus`
    // (a `ParameterBindingCensus`), never over the `RoundCensus` it came from.
    const next = compose(observed)
    let changed = next.parameters.boundCount !== previousBoundCount
    unsettled = changed ? [`boundCount ${previousBoundCount} -> ${next.parameters.boundCount}`] : []
    // Reads may lazily consult earlier views. Snapshot before querying `next`
    // so forwarding to `observed` cannot extend the map during iteration.
    const pending = [...reads].map(([name, nodes]) => [name, [...nodes]] as const)
    for (const [name, nodes] of pending) {
      for (const [node, previous] of nodes) {
        const answer = queries[name](next.parameters, node)
        const equal =
          previous === answer ||
          (Array.isArray(previous) &&
            Array.isArray(answer) &&
            previous.length === answer.length &&
            previous.every((type, index) => type === answer[index])) ||
          (isFrameFact(previous) && isFrameFact(answer) && sameImplicitArgumentsTuple(previous, answer))
        if (!equal) {
          changed = true
          if (unsettled.length < 8 && typeof node.getSourceFile === 'function') {
            const file = node.getSourceFile()
            const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1
            unsettled.push(
              `${name} ${file.fileName}:${line} ${node.getText().slice(0, 70)}: ${factLabel(previous)} -> ${factLabel(answer)}`
            )
          }
        }
      }
    }
    if (process.env['GEA_BINDING_CONVERGENCE_DEBUG']) process.stderr.write(`[CONVERGENCE ${rounds}] ${unsettled.join('\n')}\n`)
    // Return `next` directly rather than stashing it in an outer `round` first:
    // a settling round's `facts` (this round's `ValueFlowIndex` included) must
    // reach the caller, but a NON-settling round's `facts` must not survive
    // this iteration at all -- there is no next reader for them, ever, settled
    // or not. `next` is a `const` scoped to this iteration; once `previousCensus`
    // below takes only its `.parameters`, nothing in this function still names
    // this round's `facts` and the round's index/session graph is free the
    // moment `next` goes out of scope, unlike the old flow where the outer
    // `round` binding kept it reachable until being overwritten one line later.
    if (!changed) return { ...next, round: rounds }
    previousCensus = next.parameters
  }
  throw new Error(
    `binding census did not reach a fixed point after ${limit} rounds; refusing to publish unsettled value facts\n${unsettled.join('\n')}`
  )
}
