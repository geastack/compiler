import type { DeclarationId, FunctionId, IrValueId, RegionId } from '../../identity/ids.js'
import type { ClassLayout } from '../../projection/classes.js'
import type { IrBody, IrOperand, IrOperation } from '../../ir/model.js'
import { classMemberOf } from '../../projection/fields.js'
import { operandsOfIrOperation } from '../../ir/queries.js'
import { fieldDeclaringStructOf, structNameOfReceiver } from './class-layout.js'
import type { ReactiveCellPlan } from './host/host-members.js'

/**
 * Which reactive fields one body READS, and through which receiver.
 *
 * A JSX slot whose value is computed -- `class={done ? 'a' : 'b'}` -- reaches
 * the emitter as a call of a thunk (`plugins/gea/reactive-slots.ts`), and the
 * caller has to subscribe that thunk to every field the expression depends on.
 * The caller cannot see inside the callee's body, and the two are emitted
 * independently and in no guaranteed order, so the answer is computed here,
 * once, over the whole IR before any body is rendered.
 *
 * `source` is what the caller needs in order to NAME the owning object, and
 * there are exactly two shapes a slot expression uses:
 *
 *   - `binding` -- a module-scope store (`todo.done1`). Its cell is a global
 *     with a stable C++ name, reachable from any body, which is what makes
 *     subscribing from the caller possible at all.
 *   - `receiver` -- the component's own field (`this.count`). The thunk's
 *     receiver and the enclosing template's receiver are the same object, so
 *     the caller subscribes through its own.
 *
 * Any other receiver -- a parameter, a local, a field of a field -- is NOT
 * recorded. The caller has no expression for such an object, and inventing one
 * would subscribe the wrong instance; the slot keeps its once-only behaviour
 * and is a stated gap rather than a binding to the wrong owner.
 *
 * TRANSITIVE through a call whose callee this IR closed (`CallOperation.
 * closedCallee`), and it has to be. A GETTER is spelled exactly like a field --
 * `{reader.pageNumberLabel}` beside `{reader.openLabel}` -- but lowers to a
 * call, so a body-only reading found no dependency, `emit-jsx.ts` fell through
 * to the once-only `leafText`, and the slot froze at whatever it read on the
 * first render. The e-reader's page counter said "1 / 1" for a fourteen-hundred
 * page book, for the life of the program.
 *
 * What made the old reading "honest" was NAMEABILITY, not locality, and that is
 * preserved: a callee dependency on a module-scope store is kept as it stands
 * (a global cell is reachable from any frame), while one on the callee's own
 * `this` is re-pointed through the receiver THIS call passes -- and dropped
 * when that receiver is not a shape the caller can name, which is the same test
 * the direct pass applies to its own reads. So the widening still never
 * subscribes to the wrong object; it only stops missing the right one.
 *
 * Over-subscribing is the failure this trades INTO, and for a VALUE slot it is
 * benign: a slot that re-renders when a field its callee read changes without
 * changing the slot's value re-renders to the same text, and every apply there
 * is idempotent. For a NODE slot it is not -- re-running takes the subtree
 * down and builds it again, which repaints -- so that census is narrowed; see
 * `ReactiveDependencyCensus` below.
 */
export interface ReactiveDependency {
  /** The struct that DECLARES the field, which is what a member pointer must name. */
  readonly struct: string
  readonly key: string
  /**
   * `true` when the subscription goes through the field's COMPANION revision
   * cell rather than the field itself -- an array field, whose own carrier
   * cannot be a cell. See `records.ts`'s `cppReactiveRevisionFieldName`.
   */
  readonly revision: boolean
  readonly source: { readonly kind: 'receiver' } | { readonly kind: 'binding'; readonly declaration: DeclarationId }
}

const operationsByResult = (body: IrBody): ReadonlyMap<IrValueId, IrOperation> => {
  const byResult = new Map<IrValueId, IrOperation>()
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      const result = 'result' in operation ? operation.result : null
      if (result) byResult.set(result.id, operation)
    }
  }
  return byResult
}

/**
 * Every value in this body that can reach a BRANCH condition.
 *
 * The backward slice a node child's dependency narrowing is cut along. A read
 * that reaches a branch selects which subtree the body produces; a read that
 * only flows into a value the body hands onward does not, and -- when the body
 * is a component whose own JSX binds that value -- the caller re-running is
 * the one thing that cannot be justified by it. Conservative in the safe
 * direction: a `get`'s receiver is walked too, and an argument of a call whose
 * result reaches a branch counts as reaching it.
 */
const branchInfluencedValues = (body: IrBody): ReadonlySet<IrValueId> => {
  const byResult = operationsByResult(body)
  const reached = new Set<IrValueId>()
  const pending: IrValueId[] = []
  const visit = (operand: IrOperand): void => {
    if (reached.has(operand.value)) return
    reached.add(operand.value)
    pending.push(operand.value)
  }
  for (const block of body.blocks.values()) {
    const terminator = block.terminator
    if (terminator.kind === 'branch') visit(terminator.condition)
    else if (terminator.kind === 'switch') {
      visit(terminator.discriminant)
      for (const branch of terminator.cases) visit(branch.test)
    }
  }
  while (pending.length > 0) {
    const value = pending.pop()!
    const operation = byResult.get(value)
    if (!operation) continue
    for (const operand of operandsOfIrOperation(operation)) visit(operand)
  }
  return reached
}

/**
 * One dependency as this body states it, plus whether the read that found it
 * selects control flow here (`branchInfluencedValues`).
 */
interface FoundDependency {
  readonly dependency: ReactiveDependency
  readonly structural: boolean
}

const dependenciesOfBody = (
  body: IrBody,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  reactive: ReactiveCellPlan
): readonly FoundDependency[] => {
  const byResult = operationsByResult(body)
  const influenced = branchInfluencedValues(body)
  const found: FoundDependency[] = []
  const at = new Map<string, number>()
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      if (operation.kind !== 'get') continue
      const receiver = operation.receiver.representation
      const keyOperation = byResult.get(operation.key.value)
      if (!keyOperation || keyOperation.kind !== 'constant') continue
      const key = keyOperation.text
      // A class resolves the DECLARING struct along its inheritance chain; a
      // record -- an element of a reactive array -- is its own declaring
      // struct. Both end at the struct name a member pointer must name, which
      // is what the reactive plan is keyed by, and both are one function.
      const declaring = fieldDeclaringStructOf(classes, receiver, key)
      if (declaring === null) continue
      const revision = reactive.revisions.get(declaring)?.has(key) === true
      if (!revision && reactive.celled.get(declaring)?.has(key) !== true) continue
      const receiverOperation = byResult.get(operation.receiver.value)
      const source =
        receiverOperation?.kind === 'binding-read'
          ? ({ kind: 'binding', declaration: receiverOperation.declaration } as const)
          : receiverOperation?.kind === 'receiver'
            ? ({ kind: 'receiver' } as const)
            : null
      if (!source) continue
      const structural = influenced.has(operation.result.id)
      const token = `${declaring}|${key}|${source.kind}|${source.kind === 'binding' ? source.declaration : ''}`
      const existing = at.get(token)
      if (existing !== undefined) {
        // The same field read twice: structural if EITHER read is. One read
        // that steers a branch is enough to make the field select structure.
        if (structural && !found[existing]!.structural) found[existing] = { ...found[existing]!, structural: true }
        continue
      }
      at.set(token, found.length)
      found.push({ dependency: { struct: declaring, key, revision, source }, structural })
    }
  }
  return found
}

const tokenOf = (dependency: ReactiveDependency): string =>
  `${dependency.struct}|${dependency.key}|${dependency.source.kind}|${dependency.source.kind === 'binding' ? dependency.source.declaration : ''}`

/**
 * One callee dependency as the CALLER owns it, or `null` when the caller has no
 * expression for its owner.
 *
 * A `binding` source survives unchanged: it names a module-scope cell by a
 * global C++ name, and that name is the same one in every frame. A `receiver`
 * source is the callee's `this`, which the caller knows only as whatever it
 * passed -- so it is re-pointed through that operand under the SAME two shapes
 * `dependenciesOfBody` accepts for a read of its own, and refused otherwise.
 */
const throughReceiver = (
  dependency: ReactiveDependency,
  receiver: IrOperand | null,
  byResult: ReadonlyMap<IrValueId, IrOperation>
): ReactiveDependency | null => {
  if (dependency.source.kind === 'binding') return dependency
  if (!receiver) return null
  const receiverOperation = byResult.get(receiver.value)
  if (receiverOperation?.kind === 'binding-read') {
    return { ...dependency, source: { kind: 'binding', declaration: receiverOperation.declaration } }
  }
  if (receiverOperation?.kind === 'receiver') return { ...dependency, source: { kind: 'receiver' } }
  return null
}

/**
 * Every body this one enters with a receiver it names, as (callee, receiver)
 * edges for the closure below.
 *
 * TWO shapes, and the second is the one that matters here. A `call` whose
 * callee this IR closed is the obvious edge. An ACCESSOR read is not a call in
 * the IR at all -- `{reader.pageNumberLabel}` is a `get`, and it is
 * `emit-class-properties.ts` that renders it as a call of the getter's body
 * (`site.accessor.getter`) -- so a walk that looked only for `call` would miss
 * every getter in the program, which is exactly the shape a computed JSX slot
 * takes. The resolution asked here is `classMemberOf`, the same authority that
 * emitter uses, rather than a second reading of the layout.
 */
const receiverEdgesOf = (body: IrBody, classes: ReadonlyMap<DeclarationId, ClassLayout>): readonly CallEdge[] => {
  const edges: CallEdge[] = []
  const byResult = operationsByResult(body)
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      if (operation.kind === 'call') {
        const closed = operation.closedCallee
        if (closed && closed.kind === 'exact')
          edges.push({
            callee: closed.functionId,
            receiver: operation.receiver,
            lifted: byResult.get(operation.callee.value)?.kind === 'allocate-callable'
          })
        continue
      }
      if (operation.kind !== 'get') continue
      const receiver = operation.receiver.representation
      if (receiver.kind !== 'class-ref') continue
      const keyOperation = byResult.get(operation.key.value)
      if (!keyOperation || keyOperation.kind !== 'constant') continue
      const site = classMemberOf(classes, receiver.declaration, keyOperation.text)
      if (site === null || site.kind !== 'accessor' || site.accessor.getter === null) continue
      edges.push({ callee: site.accessor.getter, receiver: operation.receiver, lifted: false })
    }
  }
  return edges
}

/**
 * The two dependency censuses, one per kind of thing a subscription re-runs.
 *
 * `all` is the whole-program reading described at the top of this file: every
 * cell a body reads, transitively through the calls it closed. It is what a
 * VALUE slot wants -- a text, a prop, a style member, a class entry -- because
 * re-running one of those writes the same value again when nothing moved, and
 * over-subscribing there costs a comparison.
 *
 * `node` is the same census with one term narrowed, and it exists because for
 * a NODE child the trade `all` makes is not benign. Re-running a node binding
 * takes the subtree down and builds it again, which is a structural change to
 * the tree, which repaints the viewport. An App whose single ternary child
 * picks one of seven screens subscribes, under `all`, to every cell every
 * screen reads -- so tapping a footswitch inside the chain screen rebuilt all
 * 44 of its nodes and repainted 502x410 pixels, although the condition that
 * selects the screen never moved.
 *
 * The narrowing is two rules, and both are about what is ALREADY bound
 * somewhere else.
 *
 *   - A body's OWN reads are all kept. A component invocation's props record is
 *     built in the thunk, so `<Row value={store.x}/>` reads `x` here, and a
 *     prop that changes really does mean a different subtree.
 *   - A dependency carried in FROM a callee is kept only when it selects
 *     control flow in that callee -- it reaches a branch condition there, so it
 *     can change which node the callee returns -- and only when the callee is
 *     not itself a lifted JSX slot (`CallEdge.lifted`). A read that merely
 *     flows into the callee's own JSX is dropped, and so is a branch inside a
 *     slot the callee binds on its own node: in both cases the position that
 *     changes has a subscription of its own, and re-running the outer binding
 *     rebuilds everything above it to reach a node that would have updated
 *     itself.
 *
 * What survives the second rule is the one shape with no binding of its own: a
 * component whose BODY branches on a cell to choose which root it returns.
 */
export interface ReactiveDependencyCensus {
  readonly all: ReadonlyMap<FunctionId | RegionId, readonly ReactiveDependency[]>
  readonly node: ReadonlyMap<FunctionId | RegionId, readonly ReactiveDependency[]>
}

/** One (callee, receiver) edge, as `receiverEdgesOf` reports it. */
type CallEdge = {
  readonly callee: FunctionId
  readonly receiver: IrOperand | null
  /**
   * True when the callee is a callable this body ALLOCATED and immediately
   * called -- the shape only a lifted JSX slot has (`plugins/gea/
   * reactive-slots.ts` rewrites `{expr}` to `(() => (expr))()`).
   *
   * It matters to the node census and to nothing else. Such a thunk is a slot,
   * and a slot is BOUND at its own position: whatever it branches on is
   * already subscribed there, so carrying it further out buys nothing and
   * costs a rebuild of everything above it. The editor's
   * `{store.enabled[store.selected] && <span/>}` is the case -- its branch
   * over the enabled array is bound on the editor's own node, and carrying it
   * up made one footswitch tap rebuild the whole app.
   */
  readonly lifted: boolean
}

/**
 * A seed grown to a fixed point over the call graph.
 *
 * Two passes rather than one recursion: a call graph with a cycle (a getter
 * reading another getter that reads it back) has no bottom to recurse from,
 * and a monotone worklist over a finite set of (owner, dependency) pairs simply
 * terminates.
 */
const closeOverCalls = (
  seed: ReadonlyMap<FunctionId | RegionId, readonly ReactiveDependency[]>,
  calls: ReadonlyMap<FunctionId | RegionId, readonly CallEdge[]>,
  results: ReadonlyMap<FunctionId | RegionId, ReadonlyMap<IrValueId, IrOperation>>,
  callers: ReadonlyMap<FunctionId, ReadonlySet<FunctionId | RegionId>>,
  admits: (edge: CallEdge) => boolean
): ReadonlyMap<FunctionId | RegionId, readonly ReactiveDependency[]> => {
  const grown = new Map<FunctionId | RegionId, ReactiveDependency[]>()
  const tokens = new Map<FunctionId | RegionId, Set<string>>()
  for (const [owner, dependencies] of seed) {
    grown.set(owner, [...dependencies])
    tokens.set(owner, new Set(dependencies.map(tokenOf)))
  }

  const pending: (FunctionId | RegionId)[] = [...grown.keys()]
  while (pending.length > 0) {
    const callee = pending.pop()!
    const calleeDependencies = grown.get(callee)
    if (!calleeDependencies || calleeDependencies.length === 0) continue
    for (const caller of callers.get(callee as FunctionId) ?? []) {
      const own = grown.get(caller)
      const seen = tokens.get(caller)
      const byResult = results.get(caller)
      if (!own || !seen || !byResult) continue
      let grew = false
      for (const call of calls.get(caller) ?? []) {
        if (call.callee !== callee || !admits(call)) continue
        for (const dependency of calleeDependencies) {
          const carried = throughReceiver(dependency, call.receiver, byResult)
          if (!carried) continue
          const token = tokenOf(carried)
          if (seen.has(token)) continue
          seen.add(token)
          own.push(carried)
          grew = true
        }
      }
      if (grew) pending.push(caller)
    }
  }
  return grown
}

export const reactiveDependenciesOfBodies = (
  bodies: readonly IrBody[],
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  reactive: ReactiveCellPlan
): ReactiveDependencyCensus => {
  const empty = new Map<FunctionId | RegionId, readonly ReactiveDependency[]>()
  if (reactive.cell === null || (reactive.celled.size === 0 && reactive.revisions.size === 0))
    return { all: empty, node: empty }

  const direct = new Map<FunctionId | RegionId, readonly ReactiveDependency[]>()
  const directStructural = new Map<FunctionId | RegionId, readonly ReactiveDependency[]>()
  const calls = new Map<FunctionId | RegionId, readonly CallEdge[]>()
  const results = new Map<FunctionId | RegionId, ReadonlyMap<IrValueId, IrOperation>>()
  const callers = new Map<FunctionId, Set<FunctionId | RegionId>>()
  for (const body of bodies) {
    const owner = body.sourceOwner
    const found = dependenciesOfBody(body, classes, reactive)
    direct.set(owner, found.map((entry) => entry.dependency))
    directStructural.set(owner, found.filter((entry) => entry.structural).map((entry) => entry.dependency))
    results.set(owner, operationsByResult(body))
    const bodyCalls = receiverEdgesOf(body, classes)
    calls.set(owner, bodyCalls)
    for (const call of bodyCalls) {
      const existing = callers.get(call.callee)
      if (existing) existing.add(owner)
      else callers.set(call.callee, new Set([owner]))
    }
  }

  const bound = (edge: CallEdge): boolean => !edge.lifted
  const all = closeOverCalls(direct, calls, results, callers, () => true)
  const structural = closeOverCalls(directStructural, calls, results, callers, bound)

  // The node census: this body's own reads, plus only what its callees BRANCH
  // on. Assembled here rather than by a third closure because it is not a
  // fixed point -- it is one step out of `structural`, which already is one.
  const node = new Map<FunctionId | RegionId, readonly ReactiveDependency[]>()
  for (const [owner, own] of direct) {
    const merged = [...own]
    const seen = new Set(merged.map(tokenOf))
    const byResult = results.get(owner)
    if (!byResult) continue
    for (const call of calls.get(owner) ?? []) {
      if (!bound(call)) continue
      for (const dependency of structural.get(call.callee) ?? []) {
        const carried = throughReceiver(dependency, call.receiver, byResult)
        if (!carried) continue
        const token = tokenOf(carried)
        if (seen.has(token)) continue
        seen.add(token)
        merged.push(carried)
      }
    }
    if (merged.length > 0) node.set(owner, merged)
  }

  const allByOwner = new Map<FunctionId | RegionId, readonly ReactiveDependency[]>()
  for (const [owner, dependencies] of all) {
    if (dependencies.length > 0) allByOwner.set(owner, dependencies)
  }
  return { all: allByOwner, node }
}

/**
 * Which RECORD fields a JSX site actually binds, keyed by struct name.
 *
 * The elements of a reactive array are only worth celling when a rendered row
 * reads them -- `records.ts` cells exactly this set. Celling every element
 * record of every array field instead is not merely wasteful, it is wrong:
 * `Signal<T>` is not the field's declared carrier, so a struct that is also
 * read by something carrier-sensitive stops compiling. `gea-bench` holds both
 * `rows` (rendered) and `items` (parsed out of JSON), and celling `Item.id`
 * made `gea_json_read(reader, out.id)` an error -- a real defect found by the
 * corpus, not a hypothetical.
 *
 * Two shapes reach a JSX slot, and both are recorded:
 *
 *   - a DIRECT read -- `id={cell.id}` -- whose `get` result is the operand of
 *     an `element-prop`/`element-child`, possibly through the record that a
 *     `style={{...}}` object is built up as.
 *   - a THUNK read -- `width={cell.filled ? a : b}`, which
 *     `plugins/gea/reactive-slots.ts` rewrites to an immediately-called arrow.
 *     The operand is then the CALL, and the fields live in the callee's own
 *     body, which is a separate `IrBody`. The callee is recognised by its
 *     `allocate-callable` defining the callee operand -- the shape only an
 *     IIFE has -- and its body is swept in a second pass.
 *
 * Deliberately computed WITHOUT consulting `ReactiveCellPlan.celled`: that map
 * is derived from this one, so asking it here would be a cycle. This answers
 * the prior question -- what does the program bind -- and celling follows.
 */
export const reactiveBoundRecordFields = (bodies: readonly IrBody[]): ReadonlyMap<string, ReadonlySet<string>> => {
  const bound = new Map<string, Set<string>>()
  const thunks = new Set<FunctionId | RegionId>()

  const noteRead = (operation: IrOperation, byResult: ReadonlyMap<IrValueId, IrOperation>): void => {
    if (operation.kind !== 'get') return
    // Only RECORD receivers. A class field is celled by the plugin's own
    // `ReactiveCellPlan.fields`, which states the component's reactive members
    // directly; this map exists solely to narrow the ELEMENT records derived
    // from those fields.
    const representation = operation.receiver.representation
    if (representation.kind !== 'record' && representation.kind !== 'native-record-ref') return
    const struct = structNameOfReceiver(representation)
    const keyOperation = byResult.get(operation.key.value)
    if (struct === null || !keyOperation || keyOperation.kind !== 'constant') return
    const keys = bound.get(struct) ?? new Set<string>()
    keys.add(keyOperation.text)
    bound.set(struct, keys)
  }

  const noteThunk = (operation: IrOperation, byResult: ReadonlyMap<IrValueId, IrOperation>): void => {
    if (operation.kind !== 'call') return
    const callee = byResult.get(operation.callee.value)
    if (callee && callee.kind === 'allocate-callable') thunks.add(callee.functionId)
  }

  // Which values a `style={{...}}` record is built out of. The members of an
  // object literal in a JSX attribute do not arrive as `allocate-record`
  // fields -- they are installed as separate stores onto the allocated result
  // -- so reaching them means following the receiver, not the constructor.
  const storedInto = (body: IrBody): ReadonlyMap<IrValueId, readonly IrValueId[]> => {
    const byReceiver = new Map<IrValueId, IrValueId[]>()
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind !== 'set' && operation.kind !== 'define-own-property') continue
        const target = byReceiver.get(operation.receiver.value) ?? []
        target.push(operation.value.value)
        byReceiver.set(operation.receiver.value, target)
      }
    }
    return byReceiver
  }

  // Pass one: what each body binds DIRECTLY into a JSX slot, and which thunks
  // those slots call.
  for (const body of bodies) {
    const byResult = operationsByResult(body)
    const stores = storedInto(body)
    const queue: IrValueId[] = []
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind === 'element-prop') queue.push(operation.value.value)
        else if (operation.kind === 'element-child') queue.push(operation.child.value)
      }
    }
    const seen = new Set<IrValueId>()
    while (queue.length > 0) {
      const value = queue.pop()
      if (value === undefined || seen.has(value)) continue
      seen.add(value)
      for (const stored of stores.get(value) ?? []) queue.push(stored)
      const operation = byResult.get(value)
      if (!operation) continue
      noteRead(operation, byResult)
      noteThunk(operation, byResult)
      if (operation.kind === 'allocate-record') for (const field of operation.fields) queue.push(field.value.value)
      // A store THREADS its receiver: `style={{a, b}}` is
      // `allocate-record -> v29`, `set(v29,'a') -> v30`, `set(v30,'b') -> v31`,
      // and the attribute's operand is v31. Reaching the members means walking
      // back down that chain -- taking each store's own value AND its receiver
      // -- not looking up v31 as a receiver, which it never is.
      if (operation.kind === 'set' || operation.kind === 'define-own-property') {
        queue.push(operation.value.value)
        queue.push(operation.receiver.value)
      }
      // A carrier change is not a new value. Since lowering owns conversions,
      // a thunk call whose `double` lands in a style member's
      // `Optional<double>` is a `convert` between the call and the store, and
      // stopping here left the call unseen: the thunk was never swept, the
      // fields it reads were never bound, and so never celled -- every row of
      // button-tetris's settled stack rendered once and a locked piece
      // vanished, while the `key={cell.id}` read beside it, which needs no
      // conversion, was celled as before.
      if (operation.kind === 'convert') queue.push(operation.source.value)
    }
  }

  // Pass two: a thunk's whole body is its dependency set -- every field it
  // reads is one the slot re-reads when it re-runs -- so there is nothing to
  // trace inside it. Repeated to a fixpoint because a thunk can call another
  // (a style member's slot inside a row's slot), and a callee's body may sit
  // anywhere in `bodies` relative to its caller's.
  const swept = new Set<FunctionId | RegionId>()
  for (;;) {
    let grew = false
    for (const body of bodies) {
      if (!thunks.has(body.sourceOwner) || swept.has(body.sourceOwner)) continue
      swept.add(body.sourceOwner)
      grew = true
      const byResult = operationsByResult(body)
      for (const block of body.blocks.values()) {
        for (const operation of block.operations) {
          noteRead(operation, byResult)
          noteThunk(operation, byResult)
        }
      }
    }
    if (!grew) break
  }
  return bound
}
