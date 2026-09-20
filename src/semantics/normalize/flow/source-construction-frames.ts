import ts from 'typescript'
import { exactSourceConstructionOf, sourceConstructorSelectionsOf } from './member-call-forwarding.js'
import { isClassSpelledSourceClass, type SourceClass, type ValueFlowIndex } from './model.js'

export interface SourceConstructionFrames {
  /** Runtime classes and source bases whose instance construction work can execute. */
  readonly receiverOwnersOf: (call: ts.NewExpression) => readonly SourceClass[] | null
  /** The explicit source constructor frames entered by this construction or `super()`. */
  readonly targetsOf: (call: ts.NewExpression | ts.CallExpression) => readonly ts.SignatureDeclaration[] | null
}

interface FrameCache {
  readonly receiverOwners: WeakMap<ts.NewExpression, readonly SourceClass[] | null>
  readonly targets: WeakMap<ts.NewExpression | ts.CallExpression, readonly ts.SignatureDeclaration[] | null>
}

const caches = new WeakMap<ValueFlowIndex, FrameCache>()

/** Construction and constructor execution are different facts: an explicit
 * derived constructor runs its base body with the arguments at `super()`, not
 * with the arguments originally passed to `new Derived(...)`. */
export const sourceConstructionFramesOf = (checker: ts.TypeChecker, flow: ValueFlowIndex): SourceConstructionFrames => {
  let cache = caches.get(flow)
  if (!cache) {
    cache = { receiverOwners: new WeakMap(), targets: new WeakMap() }
    caches.set(flow, cache)
  }

  const baseSelectionsOf = (owner: ts.ClassDeclaration | ts.ClassExpression): readonly SourceClass[] | null => {
    const clauses = owner.heritageClauses?.filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword) ?? []
    if (clauses.length === 0) return []
    if (clauses.length !== 1 || clauses[0]?.types.length !== 1) return null
    const base = clauses[0].types[0]
    return base ? sourceConstructorSelectionsOf(checker, flow, base.expression) : null
  }

  const receiverOwnersOf = (call: ts.NewExpression): readonly SourceClass[] | null => {
    if (cache!.receiverOwners.has(call)) return cache!.receiverOwners.get(call)!
    const construction = exactSourceConstructionOf(checker, flow, call)
    if (!construction) {
      cache!.receiverOwners.set(call, null)
      return null
    }
    const owners = new Set<SourceClass>()
    const active = new Set<SourceClass>()
    const include = (selected: SourceClass): boolean => {
      if (active.has(selected)) return false
      if (owners.has(selected)) return true
      owners.add(selected)
      if (!isClassSpelledSourceClass(selected)) return true
      active.add(selected)
      const bases = baseSelectionsOf(selected)
      const complete = bases !== null && bases.every(include)
      active.delete(selected)
      return complete
    }
    const complete = construction.alternatives.every(include)
    const answer = complete ? [...owners] : null
    cache!.receiverOwners.set(call, answer)
    return answer
  }

  const firstExplicitConstructorOf = (
    selected: SourceClass,
    active: Set<SourceClass> = new Set()
  ): readonly ts.SignatureDeclaration[] | null => {
    if (active.has(selected)) return null
    if (!isClassSpelledSourceClass(selected)) return [selected]
    const constructors = selected.members.filter(ts.isConstructorDeclaration)
    const implementation = constructors.find((constructor) => constructor.body !== undefined)
    if (implementation) return [implementation]
    if (constructors.length > 0) return null
    active.add(selected)
    const bases = baseSelectionsOf(selected)
    if (bases === null) {
      active.delete(selected)
      return null
    }
    const targets = new Set<ts.SignatureDeclaration>()
    for (const base of bases) {
      const inherited = firstExplicitConstructorOf(base, active)
      if (inherited === null) {
        active.delete(selected)
        return null
      }
      inherited.forEach((target) => targets.add(target))
    }
    active.delete(selected)
    return [...targets]
  }

  const targetsOf = (call: ts.NewExpression | ts.CallExpression): readonly ts.SignatureDeclaration[] | null => {
    if (cache!.targets.has(call)) return cache!.targets.get(call)!
    let selections: readonly SourceClass[] | null
    if (ts.isNewExpression(call)) {
      const construction = exactSourceConstructionOf(checker, flow, call)
      selections = construction?.alternatives ?? null
    } else {
      const site = flow.callSiteOf(call)
      const dispatch = site?.operands.dispatch
      if (call.expression.kind !== ts.SyntaxKind.SuperKeyword || dispatch?.kind !== 'super-constructor' || !dispatch.home) {
        cache!.targets.set(call, null)
        return null
      }
      selections = baseSelectionsOf(dispatch.home)
      if (selections?.length === 0) selections = null
    }
    if (selections === null) {
      cache!.targets.set(call, null)
      return null
    }
    const targets = new Set<ts.SignatureDeclaration>()
    for (const selected of selections) {
      const found = firstExplicitConstructorOf(selected)
      if (found === null) {
        cache!.targets.set(call, null)
        return null
      }
      found.forEach((target) => targets.add(target))
    }
    const answer = [...targets]
    cache!.targets.set(call, answer)
    return answer
  }

  return { receiverOwnersOf, targetsOf }
}
