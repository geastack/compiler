import ts from 'typescript'
import {
  heritageClassOrInterfaceOf,
  isClassSpelledSourceClass,
  isConstructorFunction,
  type ReceiverReference,
  type SourceClass,
  type ValueFlowIndex
} from './model.js'
import {
  classConstructorKeepsInstanceOf,
  exactSourceConstructionOf,
  sourceConstructorSelectionsOf,
  type SourceConstructionFact
} from './member-call-forwarding.js'

export interface OwnedClassConstruction extends SourceConstructionFact {
  /** The authenticated constructor alternatives that belong to this inventory's exact receiver family. */
  readonly familyProjection: readonly SourceClass[]
}

export interface OwnedClassReceiverInventory {
  readonly classes: ReadonlySet<SourceClass>
  readonly initializers: readonly {
    readonly owner: SourceClass
    /**
     * The declaration whose body or initializer runs with the receiver.
     *
     * A constructor function IS its own constructor -- there is no separate
     * `ConstructorDeclaration` to name, and its field initializers are the
     * `this.<key> = ...` statements in that same body -- so the function
     * declaration stands for both, once.
     */
    readonly member: ts.ConstructorDeclaration | ts.PropertyDeclaration | ts.FunctionDeclaration | ts.FunctionExpression
    readonly references: readonly ReceiverReference[]
  }[]
  /** Source construction alternatives are retained with their exact-family projection. */
  readonly constructionFacts: readonly OwnedClassConstruction[]
}

const declaredTypeOf = (checker: ts.TypeChecker, declaration: SourceClass): ts.InterfaceType | null => {
  const symbol = declaration.name ? checker.getSymbolAtLocation(declaration.name) : checker.getTypeAtLocation(declaration).getSymbol()
  const type = symbol && checker.getDeclaredTypeOfSymbol(symbol)
  return type?.isClassOrInterface() ? type : null
}
const classDeclarationOf = (type: ts.InterfaceType): SourceClass | null => {
  const declaration = type.getSymbol()?.valueDeclaration
  return declaration && (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration) || isConstructorFunction(declaration))
    ? (declaration as SourceClass)
    : null
}
const ancestryOf = (checker: ts.TypeChecker, type: ts.InterfaceType, seen = new Set<ts.InterfaceType>()): readonly SourceClass[] => {
  if (seen.has(type)) return []
  seen.add(type)
  const own = classDeclarationOf(type)
  return [
    ...(own ? [own] : []),
    ...checker.getBaseTypes(type).flatMap((base) => {
      const declared = heritageClassOrInterfaceOf(base)
      return declared === null ? [] : ancestryOf(checker, declared, seen)
    })
  ]
}

/**
 * Every source class in the program whose ancestry reaches one of `roots`,
 * the roots included, each with its declared type; null when a root is not a
 * class the checker types. This is the whole "family" the receiver inventory
 * below walks, and the family `new this.constructor()` allocates from
 * (`thisConstructorFamilyOf`): heritage alone, read from the checker, so it
 * can be asked while that inventory is itself being built.
 */
export const sourceClassFamilyOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  roots: ReadonlySet<SourceClass>
): ReadonlyMap<SourceClass, ts.InterfaceType> | null => {
  const family = new Map<SourceClass, ts.InterfaceType>()
  for (const declaration of flow.classDeclarations) {
    const type = declaredTypeOf(checker, declaration)
    if (type && ancestryOf(checker, type).some((ancestor) => roots.has(ancestor))) family.set(declaration, type)
  }
  return [...roots].some((root) => !family.has(root)) ? null : family
}

/** Constructor/field receiver uses exist even when no code names a method on
 * the constructed object. Enumerate them and every construction that can
 * select a class in the source family before a caller tries to prove that a
 * sibling field cannot publish its owner. A mixed source choice retains all
 * alternatives beside the family projection; this is an inventory, not an
 * escape proof, so callers must still explain every receiver mention and
 * construction result.
 */
const collectOwnedClassReceiverInventory = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  roots: ReadonlySet<SourceClass>
): OwnedClassReceiverInventory | null => {
  if (roots.size === 0) return null
  const watched = process.env.GEA_OWNED_CLASS_DEBUG
  const named = (declaration: SourceClass): string => declaration.name?.text ?? '(anonymous)'
  const watching = watched !== undefined && [...roots].some((root) => named(root) === watched)
  const refuse = (reason: string, detail?: string): null => {
    if (watching) console.error(`[OWNED-CLASS] ${[...roots].map(named).join(',')} ${reason}${detail ? ` ${detail}` : ''}`)
    return null
  }
  const declarationOf = classDeclarationOf
  const ancestry = (type: ts.InterfaceType): readonly SourceClass[] => ancestryOf(checker, type)
  const family = sourceClassFamilyOf(checker, flow, roots)
  if (!family) return refuse('root-outside-family')
  const owners = new Set<SourceClass>()
  for (const type of family.values()) {
    // In particular this rejects a subclass handed to unknown code even if
    // the program never spells `new Subclass`: that code can construct one.
    if (!classConstructorKeepsInstanceOf(checker, flow, type))
      return refuse('constructor-does-not-keep-instance', named(declarationOf(type)!))
    for (const owner of ancestry(type)) owners.add(owner)
  }
  const constructionFacts: OwnedClassConstruction[] = []
  for (const { call } of flow.calls) {
    if (!ts.isNewExpression(call)) continue
    const selections = sourceConstructorSelectionsOf(checker, flow, call.expression)
    if (selections) {
      const familyProjection = selections.filter((owner) => family.has(owner))
      if (familyProjection.length === 0) continue
      const construction = exactSourceConstructionOf(checker, flow, call)
      if (
        !construction ||
        construction.alternatives.length !== selections.length ||
        selections.some((owner) => !construction.alternatives.includes(owner))
      )
        return refuse('unverified-construction', call.getText().slice(0, 60))
      // The helper admits only complete source selections whose constructors
      // preserve their instance identity. A mixed conditional keeps sibling
      // alternatives attached; classes and familyProjection remain scoped to
      // this exact nominal family.
      constructionFacts.push({ ...construction, familyProjection })
    } else {
      const type = checker.getTypeAtLocation(call)
      const alternatives = type.isUnion() ? type.types : [type]
      if (!alternatives.some((value) => value.isClassOrInterface() && family.has(declarationOf(value)!))) continue
      // An opaque constructor promising this family cannot be silently
      // omitted from its allocation inventory.
      return refuse('opaque-construction', call.getText().slice(0, 60))
    }
  }
  // Zero constructions is a COMPLETE inventory, not an unknown one. Every
  // possibly family-producing construction is either recorded with a nonempty
  // exact projection or an opaque family promise has refused above, and
  // `classConstructorKeepsInstanceOf` accounts for every mention of every
  // class binding in the family. Reaching here empty means the program creates
  // no instance of this family at all, so there is no receiver for a caller to
  // explain. Refusing it instead made three's `SpotLight` (never constructed
  // by the renderer under measurement) the terminal of 32 escapes, among them
  // `WebGLState`'s whole colour/depth/stencil buffer family.
  const initializers: OwnedClassReceiverInventory['initializers'][number][] = []
  for (const owner of owners) {
    if (!isClassSpelledSourceClass(owner)) {
      initializers.push({ owner, member: owner, references: flow.receiverReferencesToDeclaration(owner) })
      continue
    }
    for (const member of owner.members) {
      if (!ts.isConstructorDeclaration(member) && !ts.isPropertyDeclaration(member)) continue
      if ((ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0) continue
      initializers.push({ owner, member, references: flow.receiverReferencesToDeclaration(member) })
    }
  }
  return { classes: new Set(family.keys()), initializers, constructionFacts }
}

const inventories = new WeakMap<ValueFlowIndex, Map<SourceClass, OwnedClassReceiverInventory | null>>()

/**
 * A multi-class family (a union receiver, or several exact allocation
 * origins) asks the identical question every time the SAME set of roots is
 * handed back -- measured on the three.js app at 23.3 s of self time in
 * `collectOwnedClassReceiverInventory` alone, because the singleton fast path
 * below only ever covered `roots.size === 1` and every larger family fell
 * through to the uncached walk on every call, including every one of a
 * class's several members asking about the same family in the same round.
 *
 * Keyed by a canonical, ORDER-INDEPENDENT spelling of the root set rather than
 * the `Set` object identity, because `familyRootsOf` mints a fresh `Set` per
 * call even when its contents are the same roots as the last call. Ordinals
 * are minted once per `SourceClass` node (stable for the process, harmless to
 * share across flows) purely so two sets with the same members always sort to
 * the same key regardless of which order they were built in.
 */
const classOrdinals = new WeakMap<SourceClass, number>()
let nextClassOrdinal = 0
const ordinalOf = (node: SourceClass): number => {
  let id = classOrdinals.get(node)
  if (id === undefined) {
    id = nextClassOrdinal++
    classOrdinals.set(node, id)
  }
  return id
}
const rootsKey = (roots: ReadonlySet<SourceClass>): string =>
  [...roots]
    .map(ordinalOf)
    .sort((a, b) => a - b)
    .join(',')
const multiRootInventories = new WeakMap<ValueFlowIndex, Map<string, OwnedClassReceiverInventory | null>>()

export const ownedClassReceiverInventoryOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  roots: ReadonlySet<SourceClass>
): OwnedClassReceiverInventory | null => {
  // Every method of one class asks for the same source inventory. Cache the
  // inventory, never the caller's escape decision; a rebuilt flow index starts
  // a new inference round and cannot reuse facts from the previous one.
  if (roots.size === 0) return collectOwnedClassReceiverInventory(checker, flow, roots)
  if (roots.size === 1) {
    const root = roots.values().next().value!
    let entries = inventories.get(flow)
    if (!entries) inventories.set(flow, (entries = new Map()))
    if (entries.has(root)) return entries.get(root)!
    const inventory = collectOwnedClassReceiverInventory(checker, flow, roots)
    entries.set(root, inventory)
    return inventory
  }
  let held = multiRootInventories.get(flow)
  if (!held) multiRootInventories.set(flow, (held = new Map()))
  const key = rootsKey(roots)
  if (held.has(key)) return held.get(key)!
  const inventory = collectOwnedClassReceiverInventory(checker, flow, roots)
  held.set(key, inventory)
  return inventory
}
