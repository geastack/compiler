import ts from 'typescript'
import { censusRefusal, type CensusRefusal } from './census-refusal.js'
import { disjointUnionTypeOf, joinOfWrites, widestOf } from './derived-expression-type.js'
import { emptyParameterBindingCensus, type ParameterBindingCensus } from './parameter-bindings.js'
import type { ValueFlowIndex } from './flow/model.js'
import { forEachReachableStatement, type ProgramReachability } from './reachability.js'

/**
 * The type arguments a bare `new Map()`/`new Set()`/`new WeakMap()`/`new
 * WeakSet()` NEVER states, inferred from how the collection is actually used.
 *
 * `new WeakMap()` with no type arguments and no constructor argument gives
 * the checker nothing to infer from, so `WeakMapConstructor`'s own declared
 * default (`new <K extends object = object, V = any>(...)`) wins: K becomes
 * the bare `object` keyword type. That default is TypeScript's fallback, not
 * a fact about the program -- exactly the shape `local-bindings.ts` already
 * handles for an unannotated `let` with no initializer, typed by joining its
 * writes instead of trusting the checker's `any`. This module is the same
 * move for a collection's type parameters: `buffers.set(attribute, {...})`
 * one line after `const buffers = new WeakMap();` says what K actually is
 * far more precisely than the constructor's own default does.
 *
 * Concretely, this is the mechanism behind three.js's WebGL renderer
 * internals: `WebGLAttributes.js`, `WebGLEnvironments.js`,
 * `WebGLState.js` and others cache host objects (`BufferAttribute`,
 * `Texture`, framebuffers) in module-scope `WeakMap`s built with a bare `new
 * WeakMap()`, keyed by whatever untyped parameter the surrounding function
 * receives -- 56 `conversion:dynamic(declared-any-never-narrowed)->
 * record(type|720,...)` obligations on the three.js app trace to
 * exactly this shape, `type|720` being the bare `object` keyword type
 * `structural.ts` interns for `WeakMap`'s defaulted `K`.
 *
 * ## What licenses inferring at all
 *
 * - Only a `new X()` with NO explicit type arguments and NO constructor
 *   argument: the moment either is present, the program has stated its own
 *   answer and this module has nothing to add -- overriding a stated type
 *   would not be inference, it would be a second, disagreeing opinion.
 * - `X` resolved by SYMBOL, never by spelling (`checker.resolveName`, the
 *   same mechanism `host-protocols.ts`'s `keyedCollectionDeclarationsOf` and
 *   `promiseDeclarationOf` already use to name `Map`/`Set`/`WeakMap`/
 *   `WeakSet`/`Promise`/`Date` independently of the program's own text): a
 *   program that declares its OWN `class WeakMap` is never touched, because
 *   its constructor symbol is not the one `resolveName` finds at global
 *   scope.
 * - The collection's identity is tracked by the SYMBOL it is assigned to
 *   (a `const`/`let` variable, or a later plain reassignment of one), exactly
 *   the way `local-bindings.ts`'s `assignmentsBySymbol` tracks a cell -- so
 *   `WebGLState.js`'s `currentDrawbuffers`, built once at module scope and
 *   rebuilt inside a reset function, is one logical collection whose two
 *   `new WeakMap()`s must describe the same K/V, not two independent guesses.
 * - Every key argument observed across every `.get`/`.set`/`.has`/`.delete`/
 *   `.add` call on that collection must agree (`widestOf`, the one join this
 *   compiler's censuses use elsewhere) or the whole collection refuses,
 *   rather than the union of disagreeing calls becoming a source-shaped guess
 *   nobody wrote. `V` (from `.set`'s second argument) is independent of `K`:
 *   a collection this module can bind `K` for but never sees `.set` called on
 *   (or whose `.set` calls disagree) still answers `K`, leaving `V` `null` --
 *   "no override", not "refuse everything because of the other half".
 *
 * ## Composition
 *
 * `parameters` is the already-composed parameter(+return+local) census,
 * asked at every argument BEFORE this module reads the checker's own answer
 * for it fails -- no, asked the same `known ?? resolve` way every other
 * census here does: the checker's own answer first, and only when that is
 * unusable evidence (`any`/`void`/`never`) does this module fall back to
 * whatever the upstream census has already resolved for that argument. This
 * is why the majority of these 56 sites will not bind on the parameter
 * census's own: the key argument at each one is currently an unannotated
 * local function parameter, `any` all the way down, and neither this module
 * nor the checker has anything else to read yet. When the parameter census's
 * own inference improves (an optimistic-fixpoint join over a
 * self-referential parameter's own call sites is a separate, already-planned
 * change), this module needs no change at all to start binding more of them
 * -- it already asks `parameters.typeAt` for every argument.
 *
 * ## Ownership and evidence come from the shared value-flow index
 *
 * Two holes used to make this census blind to real writes, not merely to
 * exotic syntax:
 *
 * - **The alias case.** `const helper = []; fill(helper); return helper` --
 *   `fill`'s own body does `arr.push(x)` on its PARAMETER, a different
 *   declaration than `helper`'s own. Ownership used to be tracked purely by
 *   declaration identity, so a write reaching the array only through a
 *   parameter it was passed to was invisible.
 * - **The non-identifier receiver.** `this.cache.set(k, v)` or `a.b.set(k, v)`
 *   -- evidence gathering used to require the receiver be a bare identifier
 *   (`m.set(...)`), so a collection held by a property was invisible even
 *   when its OWNER was tracked, and `this.m = new Map()` was refused
 *   `owner-not-tracked` outright because ownership resolution only matched a
 *   plain-identifier assignment target.
 *
 * Both are closed by reading `flow` (`flow/model.ts`), the one whole-program
 * walk that already states every `array-append`/`array-fill`/`index-
 * assignment`/`collection-key`/`collection-value` edge FOR ANY RECEIVER
 * SHAPE it can name (identifier, `x.prop`, or a literal-keyed bracket --
 * `flowTargetOf` draws that line once, for every consumer), and every
 * `call-argument`/`declaration-initializer`/`identifier-assignment`/
 * `property-assignment` edge that carries a value's IDENTITY into a new
 * cell. `aliasClosureOf` below follows exactly the latter four kinds,
 * restricted to the `whole`-slot write (the cell's entire contents became
 * this reference, not merely one of its members), transitively, from an
 * owner's own declaration: this closes the alias case for BOTH the `Map`/
 * `Set` family and the array family with the same walk, and the
 * non-identifier receiver case falls out for free because `flow` never
 * restricted itself to identifiers in the first place -- there is no
 * separate "non-identifier receiver" fix, just consulting the index instead
 * of re-deriving a narrower answer beside it.
 */

export interface CollectionTypeArguments {
  /**
   * The inferred key type, or `null` when the census could not resolve one --
   * see `refusalOf` for which of the four reasons. `null` here is NOT a
   * refusal of the whole collection: K and V are independent questions about
   * one storage, and the checker's own defaulted key argument stays in place
   * for a collection whose VALUE this census did resolve.
   */
  readonly key: ts.Type | null
  /**
   * The inferred value type, or `null` when no `.set` call was observed (or
   * its arguments disagreed) for this collection -- meaning no override, not
   * a refusal: `key` may still be usable on its own. Always `null` for a
   * `Set`/`WeakSet`, which has no value slot to infer.
   */
  readonly value: ts.Type | null
  /**
   * The `.set` VALUE arguments this census could not type, for the one
   * refusal a later layer can still answer: `value-unresolved`.
   *
   * The checker calls `map` in `properties.set( object, map )` `any`, and the
   * one authority that knows better -- the object-bag census -- cannot be
   * consulted from here. A bag's answer is an `ObjectBagShape`, not a
   * `ts.Type`, and only becomes one through `table.intern`; `frontend.ts`
   * places `bags` AFTER `compose()` for exactly that reason, so this census
   * runs first by construction. Publishing the expressions is what lets
   * `structural-array-element.ts` -- where the table, the bag census and this
   * one are all in scope -- finish the question this census had to leave open.
   *
   * Empty whenever `value` is non-null (nothing was left open) and whenever
   * the refusal was anything else: `values-disagree` is a real disagreement
   * about one storage, and no later layer makes it agree.
   */
  readonly valueEvidence: readonly ts.Expression[]
}

export interface CollectionBindingCensus {
  /**
   * The inferred type arguments for a `new Map()`/`new Set()`/`new
   * WeakMap()`/`new WeakSet()` this census bound, or `null` when it did not
   * (including: not a candidate at all, or refused -- see `refusalOf`).
   */
  readonly typeArgumentsAt: (node: ts.NewExpression) => CollectionTypeArguments | null
  /** How many DISTINCT collections (by owning symbol) this census bound at least a key for. */
  readonly boundCount: number
  /**
   * Every candidate collection or array literal this census could not bind --
   * root, prose and owner, one `CensusRefusal` per refusal. See
   * `census-refusal.ts` for why this replaced a bare `ReadonlyMap<string,
   * number>`: a count says a cell went untyped, never WHICH one, so nothing
   * downstream could act on a single refusal. A caller that still wants the
   * old shape derives it with `censusRefusalCounts`.
   */
  readonly refusals: readonly CensusRefusal[]
  /** Why this particular `new X()` was not bound (or its owner's collection was not), or `null` if it was, or if it was never a candidate. */
  readonly refusalOf: (node: ts.NewExpression) => string | null
  /**
   * The inferred element type for an empty, unannotated array literal this
   * census bound (see the "Array element census" section below), or `null`
   * when it did not.
   */
  readonly arrayElementAt: (node: ts.ArrayLiteralExpression) => ts.Type | null
  /** Why this particular empty array literal was not bound, or `null` if it was, or if it was never a candidate (including: `settleEvolving`'s territory, not this module's). */
  readonly arrayRefusalOf: (node: ts.ArrayLiteralExpression) => string | null
  /**
   * The element type for a READ of a cell this census bound an array for --
   * `state.probe` and `this.children`, not just the `[]` that filled them.
   *
   * The census tracks an array by its OWNING DECLARATION, because that is what
   * makes two `[]` literals assigned to one property one logical array. Every
   * read of that property is a read of the same storage, so it carries the same
   * element type, and this answers it from the same map rather than making the
   * consumer reconstruct the owner. `arrayElementAt` answers the literal;
   * this answers everywhere the literal's value is subsequently named.
   */
  readonly arrayElementForRead: (expression: ts.Expression) => ts.Type | null
  /**
   * The same element type, asked instead by the CELL'S OWN DECLARATION -- the
   * node a cell's own stored type is resolved from, which is neither the
   * literal that filled it nor a later read of it.
   *
   * `const uvBuffer = []` publishes its carrier at the `VariableDeclaration`,
   * and `checker.getTypeAtLocation` on that node answers `never[]`/`any[]`,
   * so without this the cell carries `array-object(undefined)` while every
   * READ of it carries `array-object(scalar(number))` from
   * `arrayElementForRead` -- two authorities over one storage, which surfaces
   * as an unsatisfiable `binding-read-conversion` obligation per read rather
   * than as an error anywhere. MEASURED on the three.js app: 133 declarations whose own
   * type is `never[]`/`any[]` already have an answer here, and the mismatch is
   * the single largest family of unmet obligations (161 of 756).
   *
   * Owner-keyed, exactly like `typeArgumentsForOwner`: every literal feeding
   * one owner is already required to agree (see the module header), so this is
   * the SAME answer the literal and the reads get, not a second inference.
   */
  readonly arrayElementForOwner: (declaration: ts.Node) => ts.Type | null
  /**
   * Why this declaration's array component was refused, or `null` if it was
   * bound or is not part of a tracked array at all.
   *
   * Keyed by ANY declaration in the alias component -- the literal's owner,
   * an alias variable, and the PARAMETER a callee receives the array through
   * -- because `ownerArrayRefusal` is already written for every one of them.
   * A refusal is a fact about one physical array, and every cell that names
   * that array has to hear it: otherwise the owner falls back to the
   * checker's `any[]` while `parameter-bindings.ts`, which resolves a
   * parameter from its call sites and has never consulted this census, binds
   * the SAME array to a concrete element type. Two carriers for one storage,
   * and the emitter's only way to reconcile them is to copy -- which for a
   * mutable `ArrayObject` silently drops every write the callee makes
   * (three's `getProgramCacheKey`, measured).
   */
  readonly arrayRefusalForOwner: (declaration: ts.Node) => string | null
  /**
   * The same refusal, asked at a READ of the cell -- `arrayElementForRead`'s
   * counterpart, resolved through the same `ownerDeclOfExpr`.
   *
   * A refused array must read back the way it is STORED. TypeScript's
   * evolving-array analysis is flow-sensitive, so it answers `never[]` at
   * `const array = []` and a concrete union at a reference further down the
   * same function; when this census binds the array, `arrayElementForRead`
   * overrides both with one physical element and the two agree. When it
   * REFUSES, nothing overrides anything, and the declaration keeps the box
   * while a later read keeps the checker's narrower answer -- one storage,
   * two carriers, which the emitter can only reconcile by copying.
   */
  readonly arrayRefusalForRead: (expression: ts.Expression) => string | null
  /**
   * The same K/(V) `typeArgumentsAt` answers for one `new Map()`/`new Set()`/
   * `new WeakMap()`/`new WeakSet()` site, asked instead by the OWNER'S OWN
   * declaration (a `VariableDeclaration`/`PropertyDeclaration`) -- the node a
   * cell's own, un-annotated stored type is resolved from, which is not
   * generally the allocation expression itself: `private store = new Map()`
   * types the FIELD from `checker.getTypeAtLocation` on the
   * `PropertyDeclaration`, a different node than the `new Map()` it holds,
   * and a cell rebuilt in more than one place (`this.m = new Map()` in a
   * `reset()` method, alongside the constructor) has no single allocation
   * site to ask at all. Every allocation feeding one owner is already required
   * to agree (see the module header), so this is the same answer,
   * OWNER-keyed rather than allocation-site-keyed -- not a second inference.
   */
  readonly typeArgumentsForOwner: (declaration: ts.Node) => CollectionTypeArguments | null
  /**
   * `typeArgumentsForOwner`'s exact counterpart to `arrayElementForRead`: the
   * K/(V) for a READ of a cell this census bound a collection for --
   * `this.store` at `this.store.set(...)`, not just the `new Map()` that
   * filled it. Resolves the expression to its owning declaration the same
   * way every other read-site accessor here does, then defers to
   * `typeArgumentsForOwner`.
   */
  readonly typeArgumentsForRead: (expression: ts.Expression) => CollectionTypeArguments | null
}

/** A census that binds nothing, for callers that state no program. */
export const emptyCollectionBindingCensus: CollectionBindingCensus = {
  typeArgumentsAt: () => null,
  boundCount: 0,
  refusals: [],
  refusalOf: () => null,
  arrayElementAt: () => null,
  arrayRefusalOf: () => null,
  arrayElementForRead: () => null,
  arrayElementForOwner: () => null,
  arrayRefusalForOwner: () => null,
  arrayRefusalForRead: () => null,
  typeArgumentsForOwner: () => null,
  typeArgumentsForRead: () => null
}

type CollectionFamily = 'map' | 'set' | 'weak-map' | 'weak-set'

/**
 * The four standard collection constructor names, to the family each is --
 * hardcoded for the same reason `host-protocols.ts`'s `keyedCollectionFamilies`
 * is: these are core ECMAScript (`lib.es2015.collection.d.ts`), not something
 * a host installs, so there is no table to read them from.
 */
const CONSTRUCTOR_NAMES: ReadonlyMap<string, CollectionFamily> = new Map([
  ['Map', 'map'],
  ['Set', 'set'],
  ['WeakMap', 'weak-map'],
  ['WeakSet', 'weak-set']
])

const isUnusableEvidence = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0

interface CollectionEntry {
  readonly family: CollectionFamily
  readonly nodes: ts.NewExpression[]
}

/**
 * Whole-program census of every bare collection constructor's inferred type
 * arguments, once every call site that reads/writes it agrees.
 *
 * `parameters` is the already-settled, composed census (parameter+return,
 * optionally +local) -- asked at every observed argument exactly the way
 * `local-bindings.ts` asks it at every write, so this module never reopens
 * that fixpoint and never duplicates its resolution logic.
 */
export const censusCollectionBindings = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  reachable: ProgramReachability,
  parameters: ParameterBindingCensus = emptyParameterBindingCensus,
  /**
   * The whole-program value-flow index -- the ONE walk that states where every
   * write is. This module's own four collection passes read their edges from
   * it rather than re-deriving them; see `flow/model.ts`.
   */
  flow: ValueFlowIndex
): CollectionBindingCensus => {
  const anchor = files[0]
  if (!anchor) return emptyCollectionBindingCensus

  // The real global constructor VALUE symbols, resolved once -- comparing
  // AGAINST these (never against the spelling `X` in `new X()`) is what keeps
  // a program's own `class WeakMap` untouched: its constructor symbol is a
  // different symbol than the one `resolveName` finds at global scope.
  const constructorSymbols = new Map<CollectionFamily, ts.Symbol>()
  for (const [name, family] of CONSTRUCTOR_NAMES) {
    const symbol = checker.resolveName(name, anchor, ts.SymbolFlags.Value, false)
    if (symbol) constructorSymbols.set(family, symbol)
  }

  /** The family this expression constructs, if it is genuinely the standard-library constructor -- `null` otherwise. */
  const realConstructorFamily = (node: ts.NewExpression): CollectionFamily | null => {
    if (!ts.isIdentifier(node.expression)) return null
    const family = CONSTRUCTOR_NAMES.get(node.expression.text)
    if (!family) return null
    const expected = constructorSymbols.get(family)
    if (!expected) return null
    return checker.getSymbolAtLocation(node.expression) === expected ? family : null
  }

  /** A bare `new X()`: no explicit type arguments, no constructor argument -- the program stated nothing for this module to override. */
  const bareConstruction = (node: ts.NewExpression): boolean =>
    (node.typeArguments === undefined || node.typeArguments.length === 0) && (node.arguments === undefined || node.arguments.length === 0)

  // Declaration-node identity is the stable key for EVERY owner this module
  // tracks -- a variable, a class field, or a property -- not just the array
  // case below: a property symbol is late-bound per lookup (`checker.
  // getSymbolAtLocation` on a property name returns a DIFFERENT `ts.Symbol`
  // object at its declaration than at each later access), but its
  // declaration node is the same object every time. Keying `Map`/`Set`
  // ownership by symbol (as this module used to) meant `this.m = new Map()`
  // could never be tracked at all: a `BinaryExpression` whose LEFT is a
  // `PropertyAccessExpression` was rejected outright (`owner-not-tracked`),
  // and even resolving that symbol once would not have matched the DIFFERENT
  // symbol object `this.m.set(...)` resolves to later. Declaration-node
  // keying is what already lets the array census below track `state.probe`;
  // extending it to `Map`/`Set` closes both problems with the same key.
  const declNodeOf = (symbol: ts.Symbol | undefined): ts.Node | null => symbol?.getDeclarations()?.[0] ?? null

  /** The declaration node backing a plain identifier or `x.prop` property access -- `null` for anything else. */
  const ownerDeclOfExpr = (expr: ts.Expression): ts.Node | null => {
    if (ts.isIdentifier(expr)) return declNodeOf(checker.getSymbolAtLocation(expr))
    if (ts.isPropertyAccessExpression(expr)) return declNodeOf(checker.getSymbolAtLocation(expr.name))
    return null
  }

  /**
   * The declaration this construction is bound to -- a variable's own name,
   * a class field's own initializer, or the target of a plain `x = new
   * WeakMap()` / `this.m = new WeakMap()` reassignment (identifier OR
   * property access, via `ownerDeclOfExpr`). `null` for anything else
   * (destructuring, an argument passed inline, ...): this module tracks USE
   * SITES by declaration, so a construction with no trackable owner has
   * nothing for a later `.get`/`.set` to be found against, and refuses
   * rather than guessing at one.
   */
  const ownerDeclOf = (node: ts.NewExpression): ts.Node | null => {
    const parent = node.parent
    if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
      return declNodeOf(checker.getSymbolAtLocation(parent.name))
    }
    if (ts.isPropertyDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
      return declNodeOf(checker.getSymbolAtLocation(parent.name))
    }
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node) {
      return ownerDeclOfExpr(parent.left)
    }
    return null
  }

  /**
   * Every declaration this owner's value is ALIASED into by direct identity
   * -- `const b = a`, `b = a`, `o.p = a`, or `a` passed as a call argument
   * reaching a callee's parameter slot -- so a write reaching the SAME
   * reference through a different name is evidence for this owner too, not a
   * different, unrelated cell.
   *
   * Follows exactly the edges that carry a value's whole identity (`flow`'s
   * `whole`-slot writes only -- never the paired `member` write
   * `property-assignment`/`index-assignment` also record for the RECEIVER,
   * which states something about one of the receiver's members, not that the
   * receiver itself became this reference), transitively, via
   * `flowsFromDeclaration` -- the reverse edge `flow` already states for
   * every write, so this is a graph walk over data the shared index already
   * computed, not a second walk of the program.
   */
  const ALIAS_EDGES: ReadonlySet<string> = new Set([
    'declaration-initializer',
    'identifier-assignment',
    'property-assignment',
    'index-assignment',
    'call-argument'
  ])
  const aliasClosureOf = (owner: ts.Node): ReadonlySet<ts.Node> => {
    const seen = new Set<ts.Node>([owner])
    const queue: ts.Node[] = [owner]
    while (queue.length > 0) {
      const current = queue.shift() as ts.Node
      for (const write of flow.flowsFromDeclaration(current)) {
        if (write.slot !== 'whole' || !ALIAS_EDGES.has(write.edge)) continue
        const target = write.target.declaration
        if (target && !seen.has(target)) {
          seen.add(target)
          queue.push(target)
        }
      }
    }
    return seen
  }

  /**
   * Render a refusal's subject -- the declaration or construction site a
   * human (or a later tool) can find and inspect, not a re-derivable index.
   * A tracked owner is always a `VariableDeclaration`/`PropertyDeclaration`/
   * `PropertyAssignment`, all of which name themselves with a plain
   * identifier; anything without one (a bare `new X()` this module could not
   * attach to a declaration at all) falls back to its own source text.
   */
  const describeOwner = (node: ts.Node): string => {
    const sourceFile = node.getSourceFile()
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
    const name = (node as { name?: ts.PropertyName }).name
    const label = name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) ? name.text : node.getText(sourceFile)
    return `${label} (${sourceFile.fileName}:${line})`
  }

  const censusRefusals: CensusRefusal[] = []

  // Pass 1: every candidate `new X()`, grouped by owning declaration.
  const byOwner = new Map<ts.Node, CollectionEntry>()
  const nodeOwner = new Map<ts.NewExpression, ts.Node>()
  const nodeRefusal = new Map<ts.NewExpression, string>()

  const collectConstructions = (node: ts.Node): void => {
    // Mirrors `value-flow.ts`'s own `visit` guard exactly (same `reachable`,
    // same predicate): a class member reachability has pruned as dead --
    // never dispatched by symbol (a static) or by key (an instance member) in
    // live code -- contributes no write evidence to `flow` at all, by design
    // ("excluded bodies cannot contribute callers or writes to the live
    // program's typing evidence"). Before this guard, THIS walk had no such
    // exclusion: it kept collecting a bare `new Map()`/`new Set()` inside a
    // pruned method as a live candidate needing evidence, while `flow` -- the
    // only source this module reads evidence from -- had already discarded
    // every write inside that same body. The two walks disagreeing about what
    // "the program" contains turned a dead body into a GUARANTEED refusal for
    // every collection literal in it, not a measured one.
    if (reachable.memberIsPruned(node)) return
    if (ts.isNewExpression(node)) {
      const family = realConstructorFamily(node)
      if (family && bareConstruction(node)) {
        const owner = ownerDeclOf(node)
        if (!owner) {
          nodeRefusal.set(node, 'owner-not-tracked')
          censusRefusals.push(
            censusRefusal(
              'collection',
              'owner-not-tracked',
              `bare \`new ${node.expression.getText(node.getSourceFile())}()\` is not bound to a trackable declaration -- not a plain variable/field initializer, and not a reassignment through one`,
              describeOwner(node)
            )
          )
        } else {
          nodeOwner.set(node, owner)
          const existing = byOwner.get(owner)
          if (!existing) byOwner.set(owner, { family, nodes: [node] })
          else if (existing.family !== family) {
            nodeRefusal.set(node, 'family-disagreement')
            censusRefusals.push(
              censusRefusal(
                'collection',
                'family-disagreement',
                `this declaration already holds a \`${existing.family}\`; this \`new ${node.expression.getText(node.getSourceFile())}()\` assigns a disagreeing \`${family}\` to the same declaration`,
                describeOwner(owner)
              )
            )
          } else existing.nodes.push(node)
        }
      }
    }
    ts.forEachChild(node, collectConstructions)
  }
  for (const file of files) forEachReachableStatement(reachable, file, collectConstructions)

  /** The checker's own answer, falling back to the composed parameter census -- the SAME `known ?? resolve` rule every other census here applies. */
  const argumentType = (expr: ts.Expression): ts.Type | null => {
    const own = checker.getTypeAtLocation(expr)
    return isUnusableEvidence(own) ? parameters.typeAt(expr) : own
  }

  // Pass 2: every `.get`/`.set`/`.has`/`.delete`/`.add` KEY/VALUE write that
  // reaches one of the tracked collections above OR any cell in its alias
  // closure -- read from `flow` rather than re-walked, so a receiver spelled
  // `this.cache.set(...)`, `a.b.set(...)`, or reached only through a
  // parameter the collection was passed to is evidence exactly like
  // `m.set(...)` is: `flow`'s own `collection-key`/`collection-value` edges
  // never restricted themselves to an identifier receiver in the first
  // place, only this module's old re-derivation did.
  const boundKey = new Map<ts.Node, ts.Type>()
  const boundValue = new Map<ts.Node, ts.Type>()
  const ownerRefusal = new Map<ts.Node, string>()
  const valueRefusal = new Map<ts.Node, string>()
  /** The `.set` value arguments of a collection refused `value-unresolved`, for `CollectionTypeArguments.valueEvidence`. */
  const unresolvedValueArgs = new Map<ts.Node, readonly ts.Expression[]>()

  for (const [owner, entry] of byOwner) {
    if (entry.nodes.some((node) => nodeRefusal.has(node))) {
      ownerRefusal.set(owner, 'family-disagreement')
      censusRefusals.push(
        censusRefusal(
          'collection',
          'family-disagreement',
          `at least one \`new\` assigned to this declaration disagreed on collection family with another (\`${entry.family}\` vs. a differing family)`,
          describeOwner(owner)
        )
      )
      continue
    }
    const keyArgs: ts.Expression[] = []
    const valueArgs: ts.Expression[] = []
    for (const decl of aliasClosureOf(owner)) {
      for (const write of flow.writesToDeclaration(decl)) {
        if (write.edge === 'collection-key' && write.value) keyArgs.push(write.value)
        else if (write.edge === 'collection-value' && write.value) valueArgs.push(write.value)
      }
    }
    // K and V are INDEPENDENT questions about one storage, and a `continue`
    // here answered neither because the first had no answer. three's
    // `WebGLProperties` is the case that costs: `properties.set( object, map )`
    // keys a `WeakMap` by an untyped parameter, so K is `key-unresolved` --
    // while V is the 47-member bag the whole renderer reads back out of it,
    // fully determined by that very same call. Every refusal below is a
    // statement about K alone, and the checker's own (defaulted, workable) key
    // argument survives each one exactly as it did when the whole collection
    // was refused: `overriddenCollectionShape` keeps `typeArguments[0]`
    // untouched when this census binds no key.
    const key = ((): ts.Type | null => {
      if (keyArgs.length === 0) {
        ownerRefusal.set(owner, 'no-key-uses')
        censusRefusals.push(
          censusRefusal(
            'collection',
            'no-key-uses',
            'no `.get`/`.set`/`.has`/`.delete`/`.add` call with a key argument was observed reaching this collection (or any of its aliases)',
            describeOwner(owner)
          )
        )
        return null
      }
      const keyTypes: ts.Type[] = []
      for (const arg of keyArgs) {
        const type = argumentType(arg)
        if (!type) {
          ownerRefusal.set(owner, 'key-unresolved')
          censusRefusals.push(
            censusRefusal(
              'collection',
              'key-unresolved',
              `the key argument \`${arg.getText(arg.getSourceFile())}\` could not be typed (the checker's own answer was unusable and the composed parameter census had nothing to add)`,
              describeOwner(owner)
            )
          )
          return null
        }
        keyTypes.push(type)
      }
      const joined = widestOf(checker, keyTypes)
      if (!joined) {
        ownerRefusal.set(owner, 'keys-disagree')
        censusRefusals.push(
          censusRefusal(
            'collection',
            'keys-disagree',
            `the key arguments observed across this collection's calls do not join to one type: ${keyTypes.map((type) => checker.typeToString(type)).join(', ')}`,
            describeOwner(owner)
          )
        )
        return null
      }
      // A `WeakMap`/`WeakSet` key must stay a REFERENCE -- ECMA-262 24.3/24.4
      // admit only objects (and unregistered symbols) as weak keys, and
      // `representation/collections.ts`'s `deriveKeyedCollection` refuses a
      // weak key that lacks one, by design (a `WeakMap<number, T>` has no
      // correct lowering, ever). Joining evidence across every `.set`/`.get`
      // call the ordinary `widestOf` way is correct for `map`/`set` -- pure
      // structural equality never asks about pointers -- but for the weak
      // families it can join two or more UNRELATED class keys into a `T1 | T2`
      // union, or widen a nullable receiver into `T | null`: both are still
      // perfectly good TypeScript types, and both lower to a carrier
      // (`tagged-union`, `optional(...)`) with no single pointer to compare,
      // which the checker in `collections.ts` then refuses outright -- turning
      // a WORKING (boxed, dynamically-keyed) WeakMap into a hard `unresolved`
      // refusal. `WeakMap<object, V>`'s own DEFAULT (bound to nothing) already
      // compiles today via `dynamic`'s admitted reference identity
      // (`hasReferenceIdentity`'s own comment) -- this module must not narrow
      // that into something WORSE than what it is replacing. `isUnion()` is the
      // cheap, correct proxy at this layer for "does not reduce to one
      // reference-bearing shape": every case this census has actually observed
      // failing downstream (a tagged union of classes, an `optional(T, null)`)
      // is a TS union, and a single class/interface/object type -- the only
      // shape this runtime's weak families can pointer-compare -- never is one.
      if ((entry.family === 'weak-map' || entry.family === 'weak-set') && joined.isUnion()) {
        ownerRefusal.set(owner, 'weak-key-not-reference')
        censusRefusals.push(
          censusRefusal(
            'collection',
            'weak-key-not-reference',
            `the joined key type \`${checker.typeToString(joined)}\` does not reduce to one reference-bearing shape, but a \`${entry.family}\` key must stay an object (ECMA-262 24.3/24.4)`,
            describeOwner(owner)
          )
        )
        return null
      }
      return joined
    })()
    if (key) boundKey.set(owner, key)

    if (entry.family !== 'map' && entry.family !== 'weak-map') continue
    if (valueArgs.length === 0) {
      valueRefusal.set(owner, 'no-value-uses')
      censusRefusals.push(
        censusRefusal(
          'collection',
          'no-value-uses',
          'no `.set` call with a value argument was observed reaching this collection (or any of its aliases)',
          describeOwner(owner)
        )
      )
      continue
    }
    const valueTypes: ts.Type[] = []
    let everyValue = true
    for (const arg of valueArgs) {
      const type = argumentType(arg)
      if (!type) {
        everyValue = false
        break
      }
      valueTypes.push(type)
    }
    if (!everyValue) {
      valueRefusal.set(owner, 'value-unresolved')
      // The one refusal a later layer can lift -- see `valueEvidence`. The
      // expressions are published whole rather than the ones that failed,
      // because the resolver downstream must agree about ALL of them or
      // answer nothing: a value slot half-derived from this census and half
      // from the checker would be a second authority over one storage.
      unresolvedValueArgs.set(owner, valueArgs)
      censusRefusals.push(
        censusRefusal(
          'collection',
          'value-unresolved',
          "at least one `.set` value argument on this collection could not be typed (the checker's own answer was unusable and the composed parameter census had nothing to add) -- left open for structural-array-element.ts's bag resolution",
          describeOwner(owner)
        )
      )
      continue
    }
    const value = widestOf(checker, valueTypes)
    if (!value) {
      valueRefusal.set(owner, 'values-disagree')
      censusRefusals.push(
        censusRefusal(
          'collection',
          'values-disagree',
          `the \`.set\` value arguments observed do not join to one type: ${valueTypes.map((type) => checker.typeToString(type)).join(', ')}`,
          describeOwner(owner)
        )
      )
      continue
    }
    boundValue.set(owner, value)
  }

  // --- Array element census -------------------------------------------
  //
  // An empty array literal with no contextual type is `never[]` -- TypeScript
  // states nothing about what it will hold, correctly, because nothing in
  // the literal itself says. For a plain `let`/`const` binding
  // (`structural-layout-type.ts`'s `settleEvolving`/`boundSymbolOf`), the
  // checker's OWN flow analysis settles this by re-asking at the binding's
  // last reachable reference in the same file -- `let arr = []; ...
  // arr.push(x); return arr` answers `number[]` there, and that is a BETTER
  // answer than anything this module could derive, because it is
  // flow-sensitive within the function. This module must not fight that: a
  // candidate whose parent is exactly that shape (a `VariableDeclaration`
  // with a plain identifier name, initialized directly by the literal) is
  // left alone entirely, uncounted, so as never to second-guess an answer
  // TypeScript already gets right.
  //
  // What TypeScript's evolving-array machinery does NOT reach is a literal
  // that is not itself a variable's own initializer -- most concretely, a
  // property of an object literal (`const state = { probe: [] }`). A
  // property has no flow node of its own; `state.probe` is a
  // `PropertyAccessExpression` at every read, never the plain identifier
  // reference evolving-array settling requires, so the checker reports
  // `never[]` at `state.probe.push(...)` forever, even though the property
  // holds nine real `Vector3` instances by the time any of that code runs.
  // That mismatched `never` is not inert: a downstream rule reasoning about
  // reachability from a `never`-typed operand can and did treat code that
  // runs every frame as dead (see the module-level history this fix
  // responds to). Removing the false `never` at its source is the only fix
  // that cannot be undone by some future consumer trusting the certificate.
  //
  // The tracking problem is harder than the `Map`/`Set` case above: a
  // property is not held by one persistent variable `ownerSymbolOf` can
  // resolve identically at every reference. Empirically (verified against
  // this exact `WebGLLights.js` shape before writing this), `checker.
  // getSymbolAtLocation` on a property name returns a DIFFERENT `ts.Symbol`
  // object at the declaration than at each later `.prop` access -- late-bound
  // per lookup, not one persistent identity the way a variable's symbol is.
  // What IS stable across all of them is the symbol's OWN declaration node:
  // `sym.getDeclarations()?.[0]` returns the same `PropertyAssignment` AST
  // node (`probe: []` itself) every time, at the declaration and at every
  // later `.probe` access. So ownership here is tracked by DECLARATION NODE,
  // not by symbol object identity -- a strictly more general key that would
  // also work for the variable case, but the variable case already has its
  // own proven-working, declaration-keyed tracking above (`declNodeOf`/
  // `ownerDeclOfExpr`, defined once, near the top of this function, and
  // reused here) and is left untouched.
  const isUnstatedEmptyArrayLiteral = (node: ts.Node): node is ts.ArrayLiteralExpression => {
    if (!ts.isArrayLiteralExpression(node) || node.elements.length > 0) return false
    const type = checker.getTypeAtLocation(node)
    if (!checker.isArrayType(type)) return false
    const [element] = checker.getTypeArguments(type as ts.TypeReference)
    if (element === undefined || (element.flags & (ts.TypeFlags.Never | ts.TypeFlags.Any)) === 0) return false
    // A contextual array type is a statement made by the surrounding
    // annotation/signature. In particular, an explicit `any[]` remains a
    // genuine dynamic boundary; only the checker-created never/any fallback
    // of an uncontextualized `[]` is evidence-free storage this census may
    // replace from its writes.
    return checker.getContextualType(node) === undefined
  }

  /**
   * The owning declaration node for a candidate empty array literal, or `null`
   * when it is not trackable at all.
   *
   * A plain variable's own initializer USED to be excluded here and left
   * entirely to `settleEvolving` -- TypeScript's own flow-sensitive narrowing
   * of an unannotated `let`/`const arr = []`. That measurement (binds 130 more
   * arrays, boxed count unchanged) was taken against a gate that only counted
   * a TOP-LEVEL `dynamic` carrier: `array-object{element: dynamic}` was
   * invisible to it, so "unchanged" meant nothing about whether the element
   * type was actually right.
   *
   * It is not always right. `settleEvolving`'s narrowing is flow-sensitive
   * WITHIN one function; when the only pushes/writes to the array happen
   * inside a NESTED function that closes over the binding (three.js's
   * `PolyhedronGeometry` builds `const vertexBuffer = []` in a constructor and
   * fills it only from a sibling nested `function subdivideFace(...)` it
   * calls), the checker cannot narrow across that boundary and every outer
   * read widens to `any[]` -- worse than `never[]`, because
   * `structural-array-element.ts`'s own read guard used to only fire for a
   * `never` element, so an `any[]`-widened read fell straight through to the
   * `dynamic` element this whole census exists to avoid.
   *
   * Admission is based on the allocation stating no element type. Once its
   * complete write set is known, every alias must use that storage element,
   * including an earlier checker read narrowed before publication elsewhere.
   */
  const arrayOwnerDeclOf = (node: ts.ArrayLiteralExpression): ts.Node | null => {
    const parent = node.parent
    if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
      return declNodeOf(checker.getSymbolAtLocation(parent.name))
    }
    if (ts.isPropertyAssignment(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
      return declNodeOf(checker.getSymbolAtLocation(parent.name))
    }
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node) {
      return ownerDeclOfExpr(parent.left)
    }
    return null
  }

  // Pass 3: every candidate empty array literal, grouped by owning declaration node.
  const arraysByOwner = new Map<ts.Node, ts.ArrayLiteralExpression[]>()
  const arrayNodeOwner = new Map<ts.ArrayLiteralExpression, ts.Node>()
  const arrayNodeRefusal = new Map<ts.ArrayLiteralExpression, string>()

  const collectArrayLiterals = (node: ts.Node): void => {
    // See the identical guard in `collectConstructions` above: this walk and
    // `flow`'s own must agree on what counts as live code, or a member
    // reachability has pruned as dead becomes a GUARANTEED `array:no-writes`
    // for every empty-array candidate inside it -- not because the array is
    // genuinely never written, but because the one place this census reads
    // writes from (`flow`) was never asked to look inside a body it had
    // already excluded. MEASURED on the three.js app: `AnimationClip.js`'s `parse`,
    // `toJSON`, `CreateFromMorphTargetSequence` (named by symbol, never
    // dispatched under that exact name anywhere reachable) and `clone`
    // (opened by key, but not by this program's own `.clone()` call shapes)
    // each push into a local array this way -- four false `no-writes`
    // refusals from one missing exclusion, not four different defects.
    if (reachable.memberIsPruned(node)) return
    if (isUnstatedEmptyArrayLiteral(node)) {
      const owner = arrayOwnerDeclOf(node)
      if (owner) {
        arrayNodeOwner.set(node, owner)
        const existing = arraysByOwner.get(owner)
        if (existing) existing.push(node)
        else arraysByOwner.set(owner, [node])
      }
      // No `else` refusal here for the `settleEvolving`-owned or genuinely
      // untrackable shapes: those are not this module's candidates at all,
      // the same way a `new WeakMap()` passed inline as a call argument
      // (rather than bound to a name) is invisible to the census above
      // rather than counted as a refusal.
    }
    ts.forEachChild(node, collectArrayLiterals)
  }
  for (const file of files) forEachReachableStatement(reachable, file, collectArrayLiterals)

  // Pass 4: every `.push`/`.unshift`/`.fill` call and every genuine INDEX
  // (non-literal-key) assignment reaching one of the tracked array literals
  // above OR any cell in its alias closure -- read from `flow`'s
  // `array-append`/`array-fill`/`index-assignment` edges rather than
  // re-walked. This is what closes the alias case for arrays: `const helper
  // = []; fill(helper)` where `fill`'s own body does `arr.push(x)` on its
  // PARAMETER now composes, because `aliasClosureOf` follows the
  // `call-argument` edge from `helper`'s declaration to that parameter's,
  // and `flow` already recorded the parameter's own `array-append` writes.
  // All three edge kinds feed the SAME join: this module does not prefer one
  // kind of evidence over another, it requires every observed element value
  // to agree, exactly as the key-argument census above does for
  // `Map`/`Set`/`WeakMap`/`WeakSet`.
  const boundElement = new Map<ts.Node, ts.Type>()
  const ownerArrayRefusal = new Map<ts.Node, string>()

  // Two allocations that reach the same held reference slot also share its
  // physical element ABI. Join their whole alias component, rather than
  // publishing incompatible answers according to which owner was visited last.
  const arrayRoots = new Map<ts.Node, ts.Node>()
  const rootOf = (node: ts.Node): ts.Node => {
    const parent = arrayRoots.get(node)
    if (!parent || parent === node) return node
    const root = rootOf(parent)
    arrayRoots.set(node, root)
    return root
  }
  for (const owner of arraysByOwner.keys()) {
    for (const alias of aliasClosureOf(owner)) {
      const ownerRoot = rootOf(owner)
      arrayRoots.set(rootOf(alias), ownerRoot)
      if (!arrayRoots.has(ownerRoot)) arrayRoots.set(ownerRoot, ownerRoot)
    }
  }
  const arrayComponents = new Map<ts.Node, Set<ts.Node>>()
  for (const alias of arrayRoots.keys()) {
    const root = rootOf(alias)
    const component = arrayComponents.get(root) ?? new Set<ts.Node>()
    component.add(alias)
    arrayComponents.set(root, component)
  }

  for (const [owner, aliases] of arrayComponents) {
    const evidence: ts.Expression[] = []
    for (const decl of aliases) {
      for (const write of flow.writesToDeclaration(decl)) {
        if ((write.edge === 'array-append' || write.edge === 'array-fill') && write.value) evidence.push(write.value)
        else if (write.edge === 'index-assignment' && write.slot === 'element' && write.value) evidence.push(write.value)
      }
    }
    if (evidence.length === 0) {
      for (const alias of aliases) ownerArrayRefusal.set(alias, 'array:no-writes')
      censusRefusals.push(
        censusRefusal(
          'collection',
          'array-no-writes',
          'no `.push`/`.unshift`/`.fill` call or index-assignment was observed writing an element into this empty array literal (or any of its aliases)',
          describeOwner(owner)
        )
      )
      continue
    }
    const elementTypes: ts.Type[] = []
    // The refusal below names the OFFENDING WRITE, the same way the
    // key-argument refusal above names its argument. A refusal that says only
    // "at least one element" sends the reader back to re-derive which one of
    // forty-eight `array.push(...)` sites it was -- and three's
    // `getProgramCacheKey` has exactly that many, spread across three
    // functions and reached through an alias closure, so the owner line alone
    // does not locate it.
    let unresolved: ts.Expression | null = null
    for (const expr of evidence) {
      const type = argumentType(expr)
      if (!type) {
        unresolved = expr
        break
      }
      elementTypes.push(type)
    }
    if (unresolved) {
      for (const alias of aliases) ownerArrayRefusal.set(alias, 'array:element-unresolved')
      const site = unresolved.getSourceFile()
      censusRefusals.push(
        censusRefusal(
          'collection',
          'array-element-unresolved',
          `the element write \`${unresolved.getText(site)}\` (${site.fileName}:${site.getLineAndCharacterOfPosition(unresolved.getStart(site)).line + 1}) ` +
            "could not be typed (the checker's own answer was unusable and the composed parameter census had nothing to add)",
          describeOwner(owner)
        )
      )
      continue
    }
    // `joinOfWrites`, not bare `widestOf`: THE SAME WRITE-SET JOIN a cell's
    // writes get, and for the same reason. `normals.push( 0, 0, 1 )` in
    // three's `PlaneGeometry`/`CircleGeometry`/`RingGeometry` states three
    // LITERAL types, none of which covers another, so `widestOf` alone
    // refused `array:elements-disagree` -- while the array's READS were
    // typed `number[]` by TypeScript's own evolving-array widening. Two
    // authorities over one storage, surfacing as an unsatisfiable
    // `binding-read-conversion:array-object(undefined)->array-object(scalar(
    // number))` at every read. A literal argument's type is a fact about the
    // CALL, not about the storage it lands in -- the same rule
    // `parameter-bindings.ts` states at its own call sites and
    // `local-bindings.ts`/`field-bindings.ts` get from this very function.
    //
    // And when no single type covers the writes, the SAME second question
    // every sibling census asks: is the disagreement itself the answer?
    // `var xs = []; xs.push(1); xs.push('a')` holds a `string | number`, and
    // the checker's own evolving-array widening says so at every reference it
    // can settle -- while this census alone refused `array:elements-disagree`,
    // which sent the storage AND every `push` slot to the box for a program
    // that declared nothing dynamic. `disjointUnionTypeOf` is that question
    // answered as the `ts.Type` this census's contract carries, built to be
    // the checker's own settled union object (see its comment for why the
    // two must be identical rather than merely alike).
    const element = joinOfWrites(checker, elementTypes) ?? disjointUnionTypeOf(checker, elementTypes)
    if (!element) {
      for (const alias of aliases) ownerArrayRefusal.set(alias, 'array:elements-disagree')
      censusRefusals.push(
        censusRefusal(
          'collection',
          'array-elements-disagree',
          `the element values written to this array do not join to one type and are not a sound disjoint union: ${elementTypes.map((type) => checker.typeToString(type)).join(', ')}`,
          describeOwner(owner)
        )
      )
      continue
    }
    for (const alias of aliases) boundElement.set(alias, element)
  }

  for (const [node, owner] of arrayNodeOwner) {
    const reason = ownerArrayRefusal.get(owner)
    if (reason) arrayNodeRefusal.set(node, reason)
  }

  /**
   * One owner's answer, or `null` when this census learned nothing about it.
   *
   * Shared by all three accessors so they cannot drift: an owner whose KEY was
   * refused but whose VALUE resolved is still an answer, and it was three
   * separate `if (!key) return null`s that made it look like nothing.
   */
  const boundArgumentsFor = (owner: ts.Node): CollectionTypeArguments | null => {
    const key = boundKey.get(owner) ?? null
    const value = boundValue.get(owner) ?? null
    const valueEvidence = unresolvedValueArgs.get(owner) ?? []
    if (key === null && value === null && valueEvidence.length === 0) return null
    return { key, value, valueEvidence }
  }

  return {
    typeArgumentsAt: (node) => {
      const owner = nodeOwner.get(node)
      if (!owner) return null
      return boundArgumentsFor(owner)
    },
    boundCount: boundKey.size,
    refusals: censusRefusals,
    refusalOf: (node) => {
      const direct = nodeRefusal.get(node)
      if (direct) return direct
      const owner = nodeOwner.get(node)
      return owner ? (ownerRefusal.get(owner) ?? null) : null
    },
    arrayElementAt: (node) => {
      const owner = arrayNodeOwner.get(node)
      if (!owner) return null
      return boundElement.get(owner) ?? null
    },
    arrayRefusalOf: (node) => arrayNodeRefusal.get(node) ?? null,
    arrayElementForRead: (expression) => {
      const owner = ownerDeclOfExpr(expression)
      return owner ? (boundElement.get(owner) ?? null) : null
    },
    arrayElementForOwner: (declaration) => boundElement.get(declaration) ?? null,
    arrayRefusalForOwner: (declaration) => ownerArrayRefusal.get(declaration) ?? null,
    arrayRefusalForRead: (expression) => {
      const owner = ownerDeclOfExpr(expression)
      return owner ? (ownerArrayRefusal.get(owner) ?? null) : null
    },
    typeArgumentsForOwner: (declaration) => {
      return boundArgumentsFor(declaration)
    },
    typeArgumentsForRead: (expression) => {
      const owner = ownerDeclOfExpr(expression)
      if (!owner) return null
      return boundArgumentsFor(owner)
    }
  }
}
