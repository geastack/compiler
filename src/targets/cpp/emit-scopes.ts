import { immediateDominatorsOf } from '../../ir/dominance.js'
import type { IrBlockId } from '../../ir/model.js'

/**
 * Where a body's locals live: the dominator tree of the graph a body RENDERS,
 * laid out as nested C++ blocks.
 *
 * A body is a `goto` graph, and C++ forbids a jump into the scope of a
 * variable whose declaration initializes it. The flat answer declared every
 * local at the top of the function, which is always legal and always the
 * widest possible lifetime: every `Ref`, `Value`, union and string any path
 * could need was constructed on entry and destroyed on exit, on EVERY call,
 * whichever path ran. An async body kept all of them in its coroutine frame
 * (2136 bytes for one hot request-handling body), and the epilogue that
 * destroyed them all was code every call fetched -- measured, a client
 * benchmark spent two thirds of its cycles waiting on instruction delivery.
 *
 * Nesting by dominance is what makes the narrow answer legal. Blocks are
 * written in a preorder of the dominator tree, each block's dominated blocks
 * inside its braces, so every predecessor of a block `Y` lies inside the
 * scope of `Y`'s immediate dominator -- which is where `Y`'s label is
 * written. A `goto` therefore only ever leaves scopes (destroying what they
 * hold, which nothing after can name) or lands beside the scope it left, after
 * that scope's declarations; it never enters one past its declarations. A back
 * edge to a loop header leaves the header's own scope and re-enters it from
 * the top, re-running each declaration -- a value defined in the header is a
 * fresh value on every turn, so that is what it means.
 *
 * Each declaration then goes to the deepest block whose subtree holds every
 * block that names it: the lowest common ancestor of its mentions. SSA makes
 * that the definition's block or above for a value, and for a merge or a cell
 * the common dominator of every write and read.
 */
export interface ScopePlan {
  readonly entry: IrBlockId
  /** Every rendered block, in dominator-tree preorder: the order the body is written in. */
  readonly order: readonly IrBlockId[]
  readonly parent: ReadonlyMap<IrBlockId, IrBlockId>
  readonly children: ReadonlyMap<IrBlockId, readonly IrBlockId[]>
  readonly depth: ReadonlyMap<IrBlockId, number>
}

/**
 * The plan for the rendered blocks `rendered` (in `blockOrder`) and the edges
 * they spell, or `null` when some rendered block has no dominator -- the graph
 * handed in does not describe what is rendered, and a flat layout is the only
 * one that does not depend on it.
 */
export const scopePlanOf = (
  entry: IrBlockId,
  rendered: readonly IrBlockId[],
  successors: ReadonlyMap<IrBlockId, readonly IrBlockId[]>
): ScopePlan | null => {
  const members = new Set(rendered)
  const predecessors = new Map<IrBlockId, IrBlockId[]>(rendered.map((id) => [id, []]))
  for (const id of rendered) for (const next of successors.get(id) ?? []) predecessors.get(next)?.push(id)
  const { immediateDominator } = immediateDominatorsOf(entry, { successors, predecessors })
  const position = new Map(rendered.map((id, index) => [id, index]))
  const parent = new Map<IrBlockId, IrBlockId>()
  const children = new Map<IrBlockId, IrBlockId[]>(rendered.map((id) => [id, []]))
  for (const id of rendered) {
    if (id === entry) continue
    const dominator = immediateDominator.get(id)
    if (dominator === undefined || !members.has(dominator)) return null
    parent.set(id, dominator)
    children.get(dominator)?.push(id)
  }
  // Siblings keep the order the flat layout wrote them in, so a body whose
  // block order already nests is written in exactly that order.
  for (const list of children.values()) list.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0))
  const order: IrBlockId[] = []
  const depth = new Map<IrBlockId, number>()
  const pending: { readonly id: IrBlockId; readonly depth: number }[] = [{ id: entry, depth: 0 }]
  while (pending.length > 0) {
    const next = pending.pop()
    if (next === undefined) break
    order.push(next.id)
    depth.set(next.id, next.depth)
    const own = children.get(next.id) ?? []
    for (let index = own.length - 1; index >= 0; index -= 1) {
      const child = own[index]
      if (child !== undefined) pending.push({ id: child, depth: next.depth + 1 })
    }
  }
  if (order.length !== rendered.length) return null
  return { entry, order, parent, children, depth }
}

/**
 * The identifiers a rendered text names. A superset of the locals it reads or
 * writes -- a member name after `.`, a word inside a string literal -- which
 * only ever widens a scope, never narrows one.
 */
export const identifiersOf = (text: string): ReadonlySet<string> => {
  const found = new Set<string>()
  let start = -1
  for (let index = 0; index <= text.length; index += 1) {
    const code = index < text.length ? text.charCodeAt(index) : 0
    const word = (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 95 || (code >= 48 && code <= 57)
    if (word) {
      if (start < 0) start = index
      continue
    }
    if (start >= 0) {
      const first = text.charCodeAt(start)
      if (!(first >= 48 && first <= 57)) found.add(text.slice(start, index))
      start = -1
    }
  }
  return found
}

/**
 * Every label a rendered text jumps to with `goto`. Read off the text rather
 * than from the terminators so an operation that spells a jump of its own is
 * seen too: the caller refuses the nested layout for a block that jumps
 * anywhere the plan's graph did not say it could.
 */
export const gotoTargetsOf = (text: string): readonly string[] => {
  const targets: string[] = []
  let from = 0
  while (true) {
    const at = text.indexOf('goto ', from)
    if (at < 0) return targets
    from = at + 5
    const before = at === 0 ? 32 : text.charCodeAt(at - 1)
    const isWordBefore =
      (before >= 97 && before <= 122) || (before >= 65 && before <= 90) || before === 95 || (before >= 48 && before <= 57)
    if (isWordBefore) continue
    let end = from
    while (end < text.length) {
      const code = text.charCodeAt(end)
      if (!((code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 95 || (code >= 48 && code <= 57))) break
      end += 1
    }
    targets.push(text.slice(from, end))
  }
}

export interface ScopedDeclaration {
  readonly name: string
  readonly type: string
}

/**
 * A declaration that may point INTO storage another local owns: a raw
 * pointer or a reference at the top level of its type. Everything else a body
 * declares owns what it holds (`Ref`, `Value`, a union, a string, a cursor
 * that retains its array) or is plain data.
 */
const isNonOwning = (type: string): boolean => {
  const trimmed = type.trimEnd()
  return trimmed.endsWith('*') || trimmed.endsWith('&')
}

/**
 * Which block's scope each declaration opens in; `null` is the function's own
 * scope, above every block.
 *
 * `mentions` is each rendered block's identifier set; `rootText` is what the
 * body writes outside every block (its entry prologue), and a declaration it
 * names stays at the top.
 *
 * A non-owning declaration may outlive nothing it points into. Its pointee's
 * owner is named wherever the pointer is derived -- `p = owner->data()` is one
 * statement -- so every declaration named in a block that names the pointer is
 * widened to enclose the pointer's scope, to a fixed point (a pointer derived
 * from a pointer widens that one's owners too).
 */
export const declarationScopesOf = (
  plan: ScopePlan,
  declarations: readonly ScopedDeclaration[],
  mentions: ReadonlyMap<IrBlockId, ReadonlySet<string>>,
  rootText: string
): ReadonlyMap<string, IrBlockId | null> => {
  const names = new Set(declarations.map((entry) => entry.name))
  const blocksNaming = new Map<string, IrBlockId[]>()
  for (const id of plan.order) {
    for (const name of mentions.get(id) ?? []) {
      if (!names.has(name)) continue
      const list = blocksNaming.get(name)
      if (list) list.push(id)
      else blocksNaming.set(name, [id])
    }
  }
  const atRoot = identifiersOf(rootText)
  const lowestCommonAncestor = (left: IrBlockId | null, right: IrBlockId | null): IrBlockId | null => {
    if (left === null || right === null) return null
    let a: IrBlockId = left
    let b: IrBlockId = right
    while ((plan.depth.get(a) ?? 0) > (plan.depth.get(b) ?? 0)) a = plan.parent.get(a) ?? plan.entry
    while ((plan.depth.get(b) ?? 0) > (plan.depth.get(a) ?? 0)) b = plan.parent.get(b) ?? plan.entry
    while (a !== b) {
      a = plan.parent.get(a) ?? plan.entry
      b = plan.parent.get(b) ?? plan.entry
    }
    return a
  }
  const scopes = new Map<string, IrBlockId | null>()
  for (const { name } of declarations) {
    const blocks = blocksNaming.get(name) ?? []
    if (atRoot.has(name) || blocks.length === 0) {
      scopes.set(name, null)
      continue
    }
    let scope: IrBlockId | null = blocks[0] ?? null
    for (const block of blocks) scope = lowestCommonAncestor(scope, block)
    scopes.set(name, scope)
  }
  const nonOwning = declarations.filter((entry) => isNonOwning(entry.type)).map((entry) => entry.name)
  for (let changed = nonOwning.length > 0; changed;) {
    changed = false
    for (const pointer of nonOwning) {
      const pointerScope = scopes.get(pointer) ?? null
      for (const block of blocksNaming.get(pointer) ?? []) {
        for (const name of mentions.get(block) ?? []) {
          if (name === pointer || !scopes.has(name)) continue
          const current = scopes.get(name) ?? null
          const widened = lowestCommonAncestor(current, pointerScope)
          if (widened === current) continue
          scopes.set(name, widened)
          changed = true
        }
      }
    }
  }
  // A declaration scoped at the entry block lives exactly as long as one at the
  // top of the function; writing it there keeps a body that nests nothing
  // written as it always was.
  for (const [name, scope] of scopes) if (scope === plan.entry) scopes.set(name, null)
  return scopes
}
