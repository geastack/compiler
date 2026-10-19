import ts from '#typescript'
import type { ValueFlowIndex } from './model.js'
import { classConstructorBindingUsesAreClosed, sourceConstructorSelectionsOf } from './member-call-forwarding.js'
import { sourceClassFamilyOf } from './owned-class-receivers.js'
import { sourceValueSessionOf } from './source-value-session.js'

export interface SourceRawConstructorAllocation {
  readonly kind: 'base-constructor-initial-allocation'
  readonly receiver: ts.ThisExpression
  readonly constructor: ts.ConstructorDeclaration
  readonly entries: readonly {
    readonly construction: ts.NewExpression
    readonly newTarget: ts.ClassDeclaration | ts.ClassExpression
    /** Initial class prototype identities, not a post-mutation chain proof. */
    readonly initialPrototypeOwners: readonly (ts.ClassDeclaration | ts.ClassExpression)[]
  }[]
}

/** The initial receiver allocated for a source BASE class constructor.
 * Derived `this` after super can already be a returned Proxy and is refused.
 * The construction result is not returned here or equated with this receiver.
 * Consumers still owe effects/prototype integrity at their operation position.
 * @semanticCategory generic-primitive
 */
export const sourceRawConstructorAllocationOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  receiver: ts.ThisExpression
): SourceRawConstructorAllocation | null => {
  let frame: ts.Node | undefined = receiver.parent
  while (frame && (!ts.isFunctionLike(frame) || ts.isArrowFunction(frame))) frame = frame.parent
  if (!frame || !ts.isConstructorDeclaration(frame) || !frame.body) return null
  const owner = frame.parent
  if (owner.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)) return null
  const family = sourceClassFamilyOf(checker, flow, new Set([owner]))
  if (family === null) return null
  for (const type of family.values()) if (!classConstructorBindingUsesAreClosed(checker, flow, type)) return null
  const entries: SourceRawConstructorAllocation['entries'][number][] = []
  for (const site of flow.calls) {
    if (!ts.isNewExpression(site.call)) continue
    const selections = sourceConstructorSelectionsOf(checker, flow, site.call.expression)
    if (selections === null) {
      const symbol = checker.getTypeAtLocation(site.call).getSymbol()
      if (symbol?.declarations?.some((declaration) => family.has(declaration as ts.ClassDeclaration))) return null
      continue
    }
    for (const selected of selections) {
      if (!family.has(selected)) continue
      // An escaped result can expose its constructor through the default
      // instance/prototype constructor property, with no further spelled
      // class-binding reference. Closing that value is a separate obligation
      // from preserving `new`'s result identity. Unsupported returned Proxy
      // ownership remains refused rather than being replaced by the raw this.
      if (sourceValueSessionOf(checker, flow).closedValuesOf(site.call) === null) return null
      if (!ts.isClassDeclaration(selected) && !ts.isClassExpression(selected)) return null
      const chain: (ts.ClassDeclaration | ts.ClassExpression)[] = []
      const seen = new Set<ts.Node>()
      let current: ts.ClassDeclaration | ts.ClassExpression = selected
      for (;;) {
        if (seen.has(current)) return null
        seen.add(current)
        chain.push(current)
        if (current === owner) break
        const bases = current.heritageClauses?.filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword) ?? []
        if (bases.length !== 1 || bases[0]?.types.length !== 1) return null
        const heritage = bases[0].types[0]
        const choices = heritage ? sourceConstructorSelectionsOf(checker, flow, heritage.expression) : null
        const base = choices?.length === 1 ? choices[0] : null
        if (!base || (!ts.isClassDeclaration(base) && !ts.isClassExpression(base))) return null
        current = base
      }
      entries.push({ construction: site.call, newTarget: selected, initialPrototypeOwners: chain })
    }
  }
  return entries.length === 0 ? null : { kind: 'base-constructor-initial-allocation', receiver, constructor: frame, entries }
}
