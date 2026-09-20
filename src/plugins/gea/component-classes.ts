import ts from 'typescript'
import type { DeclarationId } from '../../identity/ids.js'
import { normalCompletion } from '../../semantics/model/operands.js'
import type { SemanticOperation } from '../../semantics/model/operations.js'
import type { CensusCandidate } from '../../semantics/normalize/census.js'
import type { CandidateContribution, FamilyProducer } from '../../semantics/normalize/contribution.js'
import type { ProducerContext } from '../../semantics/normalize/producer-context.js'
import { createClassLifecycleProducer } from '../../semantics/normalize/producers/class-lifecycle.js'
import { mintOperationId, mintResult, operand } from '../../semantics/normalize/producers/mint.js'
import { derivesFromGeaComponent, derivesFromGeaReactiveBase, geaMountedElementMemberName, geaRenderMemberName } from './contract.js'

/**
 * Which classes are gea's, by declaration -- not by the shape of one element
 * that happened to construct one.
 *
 * `contract.ts`'s own `derivesFromGeaComponent` is already the one symbol-
 * identity test for "is this class one of gea's"; every existing caller asks
 * it about a *constructed instance*, because every existing caller starts from
 * a JSX tag (`producer.ts`'s `createGeaElementProducer`). The render bridge
 * (`render-bridge.ts`) starts from the opposite end -- an ordinary property
 * read, `instance.render(root, depth)`, on a class that may never once appear
 * as a JSX tag in the whole program (`primitives.ts`'s `mount()` reads its own
 * root component this way, and a root is rarely also written as `<App/>`
 * somewhere) -- so nothing upstream has asked gea's question for it yet.
 *
 * This producer asks it once per class declaration, the same way
 * `createGeaElementProducer` asks `elementFactsOf` once per element: delegate
 * to the core class-lifecycle producer for the operations every consumer of
 * the graph reads, and record gea's own answer to a question the language
 * itself has no member for, alongside it rather than inside it.
 */
/**
 * Whether the class this member is declared in derives from the named gea base.
 *
 * Reached through the class's own *symbol*, never through a value expression
 * that references it: a class *declaration*'s type carries no construct
 * signatures at all, so `getDeclaredTypeOfSymbol` is the only way to the
 * instance type from here. An anonymous class expression has no name to
 * resolve a symbol from and is left unclaimed rather than guessed at -- the
 * same rule, and the same reason, as the `template` lookup below.
 */
const enclosingClassDerives = (
  context: ProducerContext,
  node: ts.Node,
  test: (checker: ts.TypeChecker, instance: ts.Type) => boolean
): boolean => {
  const classNode = node.parent
  if (!ts.isClassLike(classNode) || !classNode.name) return false
  const symbol = context.checker.getSymbolAtLocation(classNode.name)
  const instance = symbol && context.checker.getDeclaredTypeOfSymbol(symbol)
  return instance !== undefined && instance !== null && test(context.checker, instance)
}

/**
 * Every own field of every class that extends one of gea's reactive bases,
 * keyed by the class.
 *
 * Recorded for ALL such fields, with no filter on what the field holds. Which
 * of them can actually be held in a reactive cell is a question about the
 * field's physical carrier, and no carrier exists yet at this point in the
 * pipeline -- deciding it here would mean guessing from syntax what
 * `derive.ts` has not yet been asked. The target makes that call where
 * carriers are known (`records.ts`), and a field whose carrier cannot be
 * celled is left a plain member there rather than being silently dropped from
 * a set this producer had already narrowed.
 *
 * Own fields only, because that is all a `define-field` event names: a base's
 * fields are the base's, and its own evaluation publishes them under its own
 * class. The layout walk that reads this back (`classMemberOf`) already goes
 * down the chain, so an inherited reactive field is found under the class that
 * really declares it -- which is also the class whose struct declares its
 * storage, and therefore the only class whose struct may cell it.
 */
export type GeaReactiveFields = Map<DeclarationId, Set<string>>

/**
 * The `define-field` event `Component`'s own `el` never publishes.
 *
 * `el` is a declared TypeScript member -- `readonly el: RootElement | null`
 * (`core/packages/core/index.d.ts:611`) -- and every component class inherits
 * it. What it has never had is an *event*: `Component` is ambient, an ambient
 * body is interned data-only, and `projection/classes.ts` assembles a layout
 * from the events a class's evaluation published. So the member the checker
 * reports and the member the layout carries disagreed, and `this.el` refused
 * with "not a field, accessor, or method" -- while the mount bridge had a real
 * node in hand and nowhere to put it.
 *
 * Published here rather than by widening the core producer to ambient bases,
 * because it is gea that decides a mounted component holds its root: the field
 * exists for `render-bridge.ts` to write and for `onAfterRender()` to read, and
 * both of those are this plugin's. The event is minted from the same ordinal
 * counter the core producer just used for this node, so the identity cannot
 * collide with one it published; the key, descriptor and effects are exactly
 * what `class-lifecycle.ts` builds for an instance field declared without an
 * initializer, because that is what this is.
 *
 * The declaration cited is `Component.el`'s own -- the member really is
 * declared once, on the base -- so a read of `this.el` resolves to the same
 * declaration this event installs, and `derive.ts` reads the carrier off the
 * declared type (`RootElement | null`) rather than off anything invented here.
 */
const mountedElementField = (
  context: ProducerContext,
  candidate: CensusCandidate,
  classDeclaration: DeclarationId,
  reference: ts.Identifier,
  instance: ts.Type
): SemanticOperation | null => {
  const property = context.checker.getPropertyOfType(instance, geaMountedElementMemberName)
  if (!property) return null
  const declaration = context.identities.symbolDeclarationId(property, reference)
  if (!declaration) return null
  const id = mintOperationId(context.ordinals, candidate.id, 'class-lifecycle')
  return {
    id,
    caller: candidate.caller,
    operands: [
      operand(
        'key',
        0,
        { kind: 'constant', text: geaMountedElementMemberName, literal: 'string' },
        context.table.intern({ kind: 'primitive', primitive: 'string' })
      )
    ],
    results: [mintResult(id, 'completion', context.table.intern({ kind: 'primitive', primitive: 'undefined' }))],
    completion: normalCompletion,
    effects: { readsMutableState: false, writesMutableState: true, allocates: false, callsUserCode: false },
    evaluationOrdinal: context.evaluationOrdinals.next(candidate.caller),
    family: 'class-lifecycle',
    event: 'define-field',
    declaration,
    classDeclaration,
    descriptor: { writable: true, enumerable: true, configurable: true },
    placement: 'own'
  }
}

export const createGeaComponentClassProducer = (
  context: ProducerContext,
  componentClasses: Set<DeclarationId>,
  reactiveFields: GeaReactiveFields
): FamilyProducer => {
  const core = createClassLifecycleProducer(context)
  return {
    family: core.family,
    contribute: (candidate): CandidateContribution => {
      const contribution = core.contribute(candidate)
      if (contribution.kind !== 'operations') return contribution
      // Only a method literally named `template` can be the member gea's own
      // render bridge calls (`geaRenderMemberName`); every other class-lifecycle
      // event -- fields, accessors, static blocks, every other method -- is not
      // this question, so the checker work below only ever runs for the one
      // candidate shape that could possibly answer it.
      const node = candidate.node
      // A reactive class's own fields, recorded from the same producer for the
      // same reason the `template` answer is: this is the one pass that sees
      // every class-lifecycle candidate, and asking gea's question anywhere
      // else would mean a second walk that could disagree with this one about
      // which classes are gea's.
      if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
        const key = node.name.text
        for (const operation of contribution.operations) {
          if (operation.family !== 'class-lifecycle' || operation.event !== 'define-field') continue
          if (!enclosingClassDerives(context, node, derivesFromGeaReactiveBase)) continue
          const owned = reactiveFields.get(operation.classDeclaration) ?? new Set<string>()
          owned.add(key)
          reactiveFields.set(operation.classDeclaration, owned)
        }
        return contribution
      }
      if (!ts.isMethodDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== geaRenderMemberName) {
        return contribution
      }
      const published: SemanticOperation[] = []
      for (const operation of contribution.operations) {
        if (operation.family !== 'class-lifecycle' || operation.event !== 'define-method') continue
        const classNode = node.parent
        if (!ts.isClassLike(classNode)) continue
        // A class *declaration*'s own type (`getTypeAtLocation` on the node
        // itself, verified empirically -- see `citations.md` section 3b) has
        // no construct signatures at all; the instance type is reached the
        // way `producers/jsx.ts`'s `childrenKeyOf` reaches a declared type
        // elsewhere in this codebase -- through the class's own *symbol*,
        // not through a value expression that references it. An anonymous
        // class expression has no name to resolve that symbol from, and is
        // left unclaimed rather than guessed at: gea's own convention names
        // every component class it constructs (`new App()`, `<App/>`), so
        // this narrows nothing the corpus needs.
        if (!classNode.name) continue
        const symbol = context.checker.getSymbolAtLocation(classNode.name)
        const instance = symbol && context.checker.getDeclaredTypeOfSymbol(symbol)
        if (instance && derivesFromGeaComponent(context.checker, instance)) {
          componentClasses.add(operation.classDeclaration)
          const mounted = mountedElementField(context, candidate, operation.classDeclaration, classNode.name, instance)
          if (mounted) published.push(mounted)
        }
      }
      return published.length === 0 ? contribution : { ...contribution, operations: [...contribution.operations, ...published] }
    }
  }
}
