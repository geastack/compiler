import ts from 'typescript'
import { declaredBaseTypesOf } from '../../semantics/ambient.js'

/**
 * What gea says a JSX element means.
 *
 * TypeScript answers half the question and stops. `<Row id={x}/>` resolves a
 * construct signature of `Row`, and `<Header/>` resolves a call signature of
 * `Header` -- the checker validates the attributes against the corresponding
 * parameter, and that is the end of what the *language* states. Whether the
 * resolved thing is invoked once and its result inserted, or instantiated and
 * re-entered on a later frame, is gea's answer, not TypeScript's.
 *
 * gea's answer, in gea's own words: a component class derives from the base its
 * runtime exports, and the member named here is the one that produces its tree.
 * Both spellings below are this library's linkage names -- the same kind of fact
 * as a module specifier -- and they are stated once, here, rather than being
 * matched for in five places.
 */
export const geaComponentBaseName = 'Component'
export const geaRenderMemberName = 'template'

/**
 * The two bases whose subclasses hold REACTIVE state, in gea's own words.
 *
 * `index.d.ts` states the split and the reason for it: `ReactiveComponent` is
 * the "opt-in base for a component that holds its OWN reactive state", and its
 * comment is explicit that "plain `Component` subclasses keep zero reactive
 * overhead". `Store` is the same fact for the singleton half -- a store exists
 * to be observed. So reactivity is not a property of being a component; it is a
 * property of extending one of exactly these two, and a compiler that made
 * every component's fields reactive would be adding overhead the library
 * promises it does not add.
 *
 * Two names rather than one because neither derives from the other: a `Store`
 * is not a `Component`. They are listed here, once, for the same reason
 * `geaComponentBaseName` is -- a linkage name is this library's, and matching
 * for it in five places is how the five drift.
 */
export const geaReactiveBaseNames: readonly string[] = ['ReactiveComponent', 'Store']

/**
 * The member `primitives.ts`'s `mount()` reaches every root component through:
 * `(instance as unknown as { render(root, depth): void }).render(root, 1)`.
 *
 * A different linkage name from `geaRenderMemberName` on purpose. `template`
 * is what a component *writes* -- the method whose body a `<Tag/>` element
 * enters once constructed (`elementFactsOf` below). `render` is not written by
 * any component: it is the one name `mount()`'s own structural cast spells,
 * naming the mount-time bridge from a real host node to a component's tree.
 * Nothing publishes a class member of this name -- `unwrapErased`
 * (`semantics/normalize/producers/erasure.ts`) sees straight through the cast
 * to the real class, which has no such method -- so `render-bridge.ts` is the
 * one place that recognizes this exact property name and rebuilds what it
 * means, the same way `geaRenderMemberName` is the one name `elementFactsOf`
 * recognizes for the opposite direction.
 */
export const geaRenderBridgeMemberName = 'render'

/**
 * The member a mounted component holds its own root node in.
 *
 * `Component` declares it -- `readonly el: RootElement | null`
 * (`core/packages/core/index.d.ts:611`) -- and the framework's own JS component
 * runtime writes it at exactly the point this compiler's mount bridge attaches
 * a tree (`CompiledReactiveComponent.render`: install the node, then call
 * `onAfterRender`). It is stated here for the same reason the two names above
 * are: it is this library's linkage name, spelled once.
 */
export const geaMountedElementMemberName = 'el'

/**
 * The hook a component's own code runs once its tree is attached.
 *
 * Not a compiler invention: the framework's JS runtime calls `this.onAfterRender()`
 * as the last step of its own `render`, right after installing the root element,
 * and v1 keeps that runtime whole for any component that declares one of the
 * lifecycle members (`geatsc-plugin-gea/src/index.ts`'s
 * `componentHasRuntimeLifecycle`). The native bridge here has no JS runtime to
 * defer to, so it performs the same two steps itself -- which is what makes the
 * hook run at all rather than being emitted as unreachable code.
 */
export const geaAfterRenderMemberName = 'onAfterRender'

/**
 * The one attribute name that is the framework's and never the component's.
 *
 * `key` is declared on gea's own `NativeViewProps` (`index.d.ts:420`) so an
 * author may write it on any element, but nothing receives it as a prop: it
 * identifies a child across re-renders for the list reconciler, and v1 says so
 * in as many words where it drops it -- "`key` belongs to the list reconciler,
 * not to the child component" (`cpp-template-renderer.ts:1671`, and again at
 * :1593 where a `key` slot is excluded from a mount's attribute set).
 *
 * Named here, rather than skipped at the one site that noticed, because it is a
 * fact about gea's props vocabulary -- the same kind of fact as the member
 * names above -- and because the guard it exempts (`lower.ts`'s
 * `requireEveryAttributeConsumed`) is otherwise right to refuse every attribute
 * no carrier field receives.
 */
export const geaReconcilerAttributeName = 'key'

/**
 * The attribute that names where to PUT a node rather than what to set on it.
 *
 * `ref` is declared on gea's props vocabulary the same way `key` is
 * (`NativeViewProps.ref?: GeaElement | null`, `index.d.ts:424`), and its
 * declared type is the ELEMENT -- so the value written there is not data the
 * node receives, it is the slot the node is stored into. v1 reads it exactly
 * that way where it collects a component's `refFields`: a `ref` slot on the
 * root, whose expression is `this.<field>`, recorded by field name
 * (`geatsc-plugin-gea/src/cpp-replacements.ts:113`).
 *
 * v1 then *declines* to compile such a component -- a non-empty `refFields`
 * makes `index.ts:151` keep the whole JS component runtime for that class -- so
 * there is no native emission to copy here, only the meaning. Naming it in this
 * file, beside `key`, is the same statement for the same reason: it is a fact
 * about gea's props vocabulary, and the one guard that would otherwise refuse
 * it (`lower.ts`'s `requireEveryAttributeConsumed`) is right about every other
 * name it refuses.
 */
export const geaRefAttributeName = 'ref'

/** How the language reaches a value-tagged element's body, as the checker resolved it. */
export type GeaInvocation = 'call' | 'construct'

export interface GeaElementFacts {
  readonly invocation: GeaInvocation
  /**
   * The member gea renders a constructed component through, or `null` when
   * nothing authenticated this class as one of gea's.
   *
   * A class the library does not claim is not a component just because an
   * element constructed it: the program may well be building an ordinary object
   * whose type happens to satisfy `JSX.ElementClass`. Recording the absence
   * rather than guessing a member name is what lets lowering refuse by name
   * instead of calling something that was never a render.
   */
  readonly renderMember: string | null
}

/**
 * Whether this class is one of gea's, decided by symbol identity.
 *
 * The base may be reached through intermediates the program wrote -- `class
 * View extends Component`, then `class Home extends View` -- so the whole chain
 * is walked. What is compared is the *symbol* the library exported, resolved
 * from the scope the class was declared in: a class extending gea's base must
 * have imported it there, and comparing the resolved symbol rather than the
 * spelling means a program that renames the import on the way in
 * (`import { Component as Base }`) is recognized, while a program that declares
 * its own unrelated `Component` is not.
 */
const derivesFromGeaBase = (checker: ts.TypeChecker, instance: ts.Type, baseName: string): boolean => {
  const chain = declaredBaseTypesOf(checker, instance)
  const targetOf = (symbol: ts.Symbol): ts.Symbol =>
    (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol

  // The base is resolved from every scope in the chain, not only the leaf's.
  //
  // Resolving it once, where the *derived* class is declared, silently assumed
  // that a gea component names gea's base in its own file. That holds for
  // `class App extends Component`, and fails for every class that reaches the
  // base through another one: the library exports `ReactiveComponent extends
  // Component`, and an app writing `import { ReactiveComponent }` never has
  // `Component` in scope at all -- so the lookup returned nothing and the whole
  // claim was abandoned before the chain that plainly contains gea's base was
  // ever compared. The class went unclaimed, and the element refused to lower.
  //
  // Each link's own declaration site is a scope where the name it extends *is*
  // visible, which is what makes walking them the right question rather than a
  // wider one: this still compares the resolved *symbol* the library exported,
  // never the spelling, so a renamed import is recognized and an unrelated
  // class merely spelled `Component` in some other file is not. What it does
  // not distinguish -- and did not before either -- is a program that declares
  // its own `Component` and genuinely extends it; such a class has gea's
  // linkage name as its real base, and telling the two apart needs a module
  // identity this library does not state anywhere.
  const bases = new Set<ts.Symbol>()
  for (const type of [instance, ...chain]) {
    const declaration = type.getSymbol()?.declarations?.[0]
    if (!declaration) continue
    const inScope = checker.resolveName(baseName, declaration, ts.SymbolFlags.Value, false)
    if (inScope) bases.add(targetOf(inScope))
  }
  if (bases.size === 0) return false
  return chain.some((candidate) => {
    const symbol = candidate.getSymbol()
    return symbol !== undefined && bases.has(targetOf(symbol))
  })
}

/** Whether this class is one of gea's components -- `derivesFromGeaBase` asked about gea's component base. */
export const derivesFromGeaComponent = (checker: ts.TypeChecker, instance: ts.Type): boolean =>
  derivesFromGeaBase(checker, instance, geaComponentBaseName)

/**
 * Whether this class holds reactive state -- the same walk, asked about either
 * reactive base.
 *
 * `some` rather than a merged lookup: each base is resolved from the scopes of
 * the chain that actually reaches it, and a class extends one of them, never
 * both. Asking twice is what keeps a `Store` recognised in a program that never
 * imports `ReactiveComponent` at all, and vice versa.
 */
export const derivesFromGeaReactiveBase = (checker: ts.TypeChecker, instance: ts.Type): boolean =>
  geaReactiveBaseNames.some((baseName) => derivesFromGeaBase(checker, instance, baseName))

/**
 * What this element's tag resolves to, or `null` when it resolves neither.
 *
 * The order is the language's: a type carrying construct signatures is newed by
 * JSX before it is called, and a type carrying both is a class expression whose
 * call half JSX never selects.
 */
export const elementFactsOf = (checker: ts.TypeChecker, tagName: ts.JsxTagNameExpression): GeaElementFacts | null => {
  const type = checker.getTypeAtLocation(tagName)
  const constructs = type.getConstructSignatures()
  if (constructs.length > 0) {
    const instance = constructs[0]?.getReturnType()
    const claimed = instance !== undefined && derivesFromGeaComponent(checker, instance)
    return { invocation: 'construct', renderMember: claimed ? geaRenderMemberName : null }
  }
  return type.getCallSignatures().length > 0 ? { invocation: 'call', renderMember: null } : null
}
