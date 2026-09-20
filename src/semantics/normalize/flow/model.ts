import ts from 'typescript'

/**
 * ONE enumeration of the ways a value reaches a storage cell in JavaScript.
 *
 * Six censuses in `semantics/normalize/` each walked the whole program and
 * each re-derived "who writes to this cell" from scratch -- incompletely, and
 * differently. Every defect fixed across a day of work was one census missing
 * one edge another census already knew: `field-bindings.ts` could not see an
 * INDEX write, `collection-bindings.ts` could not see an ALIAS, and
 * `object-bag-bindings.ts` could not see `Object.assign` until two separate
 * sessions taught it to. Each fix taught exactly one census; the other five
 * stayed blind. That is the whack-a-mole generator, and the cure is not a
 * seventh fix -- it is enumerating the edges ONCE, here, so a census that
 * gains one gains it for every cell kind it owns.
 *
 * This layer states edges, not a cell's final type. Receiver protocol
 * recognition may consult the previous census where the checker has no useful
 * type, so the frontend can rebuild the index between inference rounds.
 * Consumers share the resulting inventory while retaining their domain's
 * evidence policy, joins, and refusal vocabulary.
 */
export type FlowEdgeKind =
  /** `const x = expr` / `let x = expr` -- the declaration's own initializer. */
  | 'declaration-initializer'
  /** `x = expr`, the target a plain identifier. */
  | 'identifier-assignment'
  /** `o.p = expr`, or a named object-literal property publishing its initial value. */
  | 'property-assignment'
  /** `{ __proto__: value }` publishes a prototype, never a data-property cell. */
  | 'prototype-assignment'
  /** `o[k] = expr`. A literal `k` is a named member spelled with brackets and is reported as one. */
  | 'index-assignment'
  /** `x += 1`, `x++`, `--x` -- the slot's own previous contents participate, so this states EXISTENCE and a derived value, never a fresh one. */
  | 'compound-assignment'
  /** `x ||= v`, `x &&= v`, `x ??= v` -- the slot holds either its previous contents or `v`, so `v` is ordinary write evidence beside every other write. */
  | 'logical-assignment'
  /** An argument at a call whose callee this walk could name, reaching that callee's parameter slot. */
  | 'call-argument'
  /** `super(...)` -- the same edge, to the base constructor's parameter slot. */
  | 'super-argument'
  /**
   * An argument at a call whose callee this walk could name, reaching a REST
   * parameter -- so the callee's binding holds it as an ELEMENT of a fresh
   * array, never as the parameter's whole value. Kept apart from
   * `call-argument` because every consumer of that edge reads the parameter as
   * the argument itself, which a rest slot is not.
   */
  | 'rest-argument'
  /** `return expr` -- reaching the enclosing function's return cell. */
  | 'return'
  /** `a.push(v)` / `a.unshift(v)`. */
  | 'array-append'
  /** `a.fill(v)`. */
  | 'array-fill'
  /** The KEY argument of `m.get/set/has/delete/add(k)`. */
  | 'collection-key'
  /** The VALUE argument of `m.set(k, v)`. */
  | 'collection-value'
  /** `Object.assign(target, source)` -- a bulk write whose key set is the source's, not this layer's to enumerate. */
  | 'object-assign'
  /** `{ ...source }` / `[ ...source ]` reaching a cell -- an unenumerable key set. */
  | 'spread'
  /** A destructured binding element (`const { a } = o`, `const [x] = a`, `({ p: o.q } = v)`). */
  | 'destructuring'
  /** The DEFAULT of a destructured binding element (`const { a = 1 } = o`) -- a second value the slot can hold. */
  | 'destructuring-default'
  /** `function f(x = v)` -- a value the slot holds when a caller omits the argument. */
  | 'default-parameter'
  /** `class C { x = v }`. */
  | 'class-field-initializer'
  /** `catch (e)`. */
  | 'catch-binding'
  /** The binding of `for (const x of a)` / `for (const k in o)`. */
  | 'iteration-binding'
  /** `yield expr` / `yield* expr` reaching the generator's yield cell. */
  | 'yield'
  /** `delete o.p` / `delete o[k]` -- states the slot EXISTS and nothing about what it holds. */
  | 'delete'

/** Which part of the cell the write lands in. */
export type FlowSlotKind =
  /** The cell's own value. */
  | 'whole'
  /** A NAMED member of the cell (`cell.p = v`, or `cell['p'] = v`). */
  | 'member'
  /** An unnamed element/index slot (`cell[k] = v`, `cell.push(v)`). */
  | 'element'
  /** A keyed collection's key slot. */
  | 'collection-key'
  /** A keyed collection's value slot. */
  | 'collection-value'
  /** An unenumerable set of the cell's slots (`Object.assign`, a spread). */
  | 'bulk'

/** The iterable/key source of an indexed loop binding, captured at the write site. */
export interface IterationOrigin {
  readonly source: ts.Expression
  readonly mode: 'values' | 'keys'
  readonly asynchronous: boolean
}

/**
 * The identity of a storage cell, in all three currencies its consumers hold.
 *
 * The census interface being NODE-keyed only is itself a documented cause of
 * bypasses, and the three keys are genuinely different questions rather than
 * three spellings of one:
 *
 * - `symbol` is `checker.getSymbolAtLocation` AT THE NAMING EXPRESSION. It is
 *   what `field-bindings.ts` keys a class field on, and what makes a
 *   subclass's `this.aspect = ...` land on the BASE class's slot.
 * - `nameSymbol` is the same call asked at a property access's `.name`. It is
 *   NOT the same symbol: measured on the three.js app, 1339 of 22556 property accesses
 *   resolve to a different symbol object through the two spellings, and 55
 *   resolve through `.name` alone. Both are recorded rather than one being
 *   picked, because picking would silently change what an existing consumer
 *   sees, and this layer's whole point is that a census's answer may change
 *   only by seeing MORE writes, never by seeing different ones.
 * - `declaration` is `nameSymbol`'s (else `symbol`'s) first declaration node.
 *   A property symbol object is late-bound per lookup and not stable across
 *   references; its declaration node IS, which is why
 *   `collection-bindings.ts` and `object-bag-bindings.ts` both track ownership
 *   by it.
 */
export interface FlowTarget {
  readonly symbol: ts.Symbol | null
  readonly nameSymbol: ts.Symbol | null
  readonly declaration: ts.Node | null
}

/** One write, as this layer states it: an edge, a slot, and the expression that is the evidence. */
export interface ValueWrite {
  readonly edge: FlowEdgeKind
  readonly slot: FlowSlotKind
  /** The member name for a `member` slot; `null` for every other slot. */
  readonly member: string | null
  /**
   * The expression whose type is this write's evidence -- `null` when the edge
   * states only that the slot EXISTS (a `delete`, an unenumerable spread, an
   * iteration binding whose source this layer does not open).
   */
  readonly value: ts.Expression | null
  /** Where the write is spelled, for attribution. */
  readonly site: ts.Node
  /** The cell written. */
  readonly target: FlowTarget
  /**
   * The expression that NAMED the cell -- `o.p` for `o.p = v`, the declared
   * name for a declaration, the parameter's name for a call argument.
   *
   * Recorded because a consumer asking "is every mention of this cell
   * accounted for" has to be able to tell a mention that WRITES the cell from
   * a mention that hands its value somewhere this layer cannot follow. Without
   * it that consumer must re-derive write-target positions from syntax --
   * which is the private, differently-incomplete re-derivation this whole
   * layer exists to end.
   */
  readonly naming: ts.Expression | null
  /** The addressed property operation, retained across receiver-cell projections. */
  readonly propertyAccess: ts.PropertyAccessExpression | ts.ElementAccessExpression | null
  /** Present only for a simple `for (... of/in ...)` binding; `value` remains null. */
  readonly iterationOrigin?: IterationOrigin
}

/** A lexical receiver reference. `super` performs lookup from a home object,
 * but its receiver is still the current `this`; keeping both spellings in the
 * same inventory prevents receiver-sensitive consumers from losing that edge.
 */
export type ReceiverReference = ts.ThisExpression | ts.SuperExpression

/** One `.call`/`.apply` wrapper after resolving its executable frame.
 * `receiver` is the wrapper's `thisArg` expression (the explicit `undefined`
 * expression stays an expression); `null` means the wrapper omitted that
 * operand. `args` contains only ordinary operands reaching the target.
 */
export interface ExplicitThisCallFrame {
  readonly callee: ts.Expression
  readonly receiver: ts.Expression | null
  readonly args: readonly ts.Expression[]
}

/** One normalized set of runtime operands for an invocation. */
export type FlowInvocationDispatch =
  | { readonly kind: 'direct' }
  | { readonly kind: 'member'; readonly lookup: ts.Expression; readonly key: string | null }
  | {
      readonly kind: 'lexical-super'
      readonly home: ts.ClassDeclaration | ts.ClassExpression | ts.ObjectLiteralExpression | null
      readonly static: boolean
      readonly key: string | null
    }
  | { readonly kind: 'super-constructor'; readonly home: ts.ClassDeclaration | ts.ClassExpression | null }

export interface FlowInvocationOperands {
  /** `super()` forwards to a base constructor; `construct` creates a fresh receiver. */
  readonly kind: 'call' | 'construct' | 'super'
  /** Complete lookup semantics; unsupported lexical-super details remain explicit for refusal. */
  readonly dispatch: FlowInvocationDispatch
  /** True only when the source invocation was authenticated as Function.call/apply. */
  readonly explicitThis: boolean
  /** The executable callee after wrappers that erase at runtime are removed. */
  readonly callee: ts.Expression
  /** Ordinary receiver or explicit thisArg; lexical `super` remains the receiver marker until frame projection. */
  readonly receiver: ts.Expression | null
  /** Ordinary arguments reaching the invocation target, never including thisArg. */
  readonly args: readonly ts.Expression[]
}

/** Syntax and checker attribution are recorded once; census-dependent attribution remains a solver operation. */
export interface FlowCallSite {
  /** All discovered source bodies. This is positive reachability evidence, not call-target closure. */
  readonly targets: readonly ts.SignatureDeclaration[]
  readonly call: ts.CallExpression | ts.NewExpression
  readonly checkerDeclaration: ts.SignatureDeclaration | ts.JSDocSignature | null
  /** Attribution from the preceding inference round; argument edges cite this same declaration. */
  readonly inferredDeclaration?: ts.SignatureDeclaration | ts.JSDocSignature
  readonly explicitThis: ExplicitThisCallFrame | null
  /** The actual source invocation operands. Synthetic callback frames are represented separately by their proof. */
  readonly operands: FlowInvocationOperands
}

/**
 * The whole-program value-flow index: for any storage cell, every write that
 * reaches it, tagged by edge kind -- and the reverse, every write elsewhere
 * whose VALUE names this cell.
 */
/**
 * The declaration a class-typed instance is nominally an instance of, when that
 * declaration is source-authored rather than ambient.
 *
 * Six modules spelled this out identically and each re-derived it the same way
 * -- `type.getSymbol()?.valueDeclaration`, gated on the two class kinds and on
 * `!isDeclarationFile`. It is one concept with one answer, and the duplication
 * is the reason widening it (three's pre-ES6 `function F() { this.x = ... }`
 * renderer idiom is not a `ClassDeclaration`) reads as a six-file change
 * instead of a one-line one.
 */
export type SourceClass = ts.ClassDeclaration | ts.ClassExpression | ts.FunctionDeclaration | ts.FunctionExpression

/**
 * A source class spelled as a class, which is where its heritage and its member
 * list are readable as syntax.
 *
 * A constructor function has both facts, but neither is a `ts.ClassElement`:
 * its members are the top-level `this.<key> = <value>` writes in its body, and
 * its heritage is a `F.prototype = Object.create( B.prototype )` or a
 * `B.call( this, ... )` that TypeScript does not model as heritage at all --
 * `getBaseTypes` on such a type returns `[]` whether or not the program chains
 * one. That empty answer is the one place this widening could UNDER-count a
 * family silently rather than refuse, so every consumer that walks heritage or
 * members must reach it through this predicate and state what it does with the
 * other case.
 */
export const isClassSpelledSourceClass = (node: SourceClass): node is ts.ClassDeclaration | ts.ClassExpression =>
  ts.isClassDeclaration(node) || ts.isClassExpression(node)

/**
 * The class or interface a heritage walk reached, through the instantiation
 * `checker.getBaseTypes` puts in the way.
 *
 * `extends Base` where `Base` declares even ONE type parameter hands back a
 * `TypeReference` -- a fresh wrapper carrying `ObjectFlags.Reference` and not
 * `Class`/`Interface` -- whether or not type arguments are written, whether the
 * parameter is defaulted, and whether anything reads it. `isClassOrInterface()`
 * tests only the object's own flags, so it answers `false` for every generic
 * base and `true` for every non-generic one, and a walk that asks it directly
 * silently decides a class has an unknown ancestry the moment its base takes a
 * type parameter. The declared class is one hop away, on `.target`.
 *
 * Ancestry is an identity question, so it is asked of the declaration the
 * reference points at, never of the instantiation standing in front of it. Any
 * walk over `getBaseTypes` must come through here.
 */
export const heritageClassOrInterfaceOf = (type: ts.Type): ts.InterfaceType | null => {
  if (type.isClassOrInterface()) return type
  const target = (type as ts.TypeReference).target as ts.Type | undefined
  return target !== undefined && target !== type && target.isClassOrInterface() ? target : null
}

/**
 * Whether a plain function is a CLASS: the pre-ES6 `function F() { this.x = ... }`
 * idiom three's whole renderer is written in.
 *
 * TypeScript already models these as classes -- `getDeclaredTypeOfSymbol` on
 * such a function returns a type carrying `ObjectFlags.Class`, answering
 * `isClassOrInterface()`, with exactly the members those `this.x =` writes
 * produce. The compiler's own gates were the only thing that did not, and they
 * were syntactic: `ts.isClassDeclaration(d) || ts.isClassExpression(d)`,
 * spelled once per consumer.
 *
 * Three admission conditions, each of which is the reason a whole class of
 * silent wrong answers cannot happen rather than a convenience:
 *
 * - at least one top-level `this.<name> = ...`. This is the same evidence
 *   TypeScript's own JS inference keys on, so the checker's answer and this
 *   one cannot disagree about which functions are classes.
 * - no top-level `return <expression>` OTHER THAN `return this`. `new F()`
 *   yields the returned object instead of `this` when a constructor returns
 *   one, so a revealing-module factory (`function WebGLState() { ... return {
 *   setMask, ... } }` -- three has as many of those as it has of these) is a
 *   DIFFERENT mechanism whose instances are object literals, and admitting it
 *   here would attribute its instances to a family they are not in. A bare
 *   `return;` is the ordinary early exit and is not a value.
 *
 *   `return this` is the one expression return that is not that hazard: what
 *   `new F()` yields is `this` either way, which is the invariant every
 *   consumer actually depends on (`classConstructorKeepsInstanceUncached`
 *   spells it "construction always yields `this`"). Refusing it tested the
 *   PROXY -- "does a return statement carry an expression" -- instead of the
 *   property, and three's `WebGLProgram` ends exactly that way, which starved
 *   `familyRootsOf` for every receiver typed `WebGLProgram` and left
 *   `program.usedTimes` unattributable in `WebGLPrograms.acquireProgram`.
 *   Widen this ONLY to `this`: dropping the check, or admitting any return,
 *   readmits the `WebGLState` factory above and turns a refusal into a wrong
 *   answer.
 * - no prototype-chain heritage. `F.prototype = Object.create( B.prototype )`
 *   and `B.call( this, ... )` are how this idiom spells `extends`, and
 *   TypeScript does NOT model either as heritage: `getBaseTypes` answers `[]`
 *   whether or not the program chains one. Every consumer reads that empty
 *   answer as "no base, the family ends here", so a chained constructor
 *   function would make the family silently SMALLER than it is -- a wrong
 *   answer, not a refusal. Refusing the candidate outright is what keeps the
 *   empty answer honest. (Measured: none of three's constructor functions
 *   chains, so this guard costs nothing and buys the soundness argument.)
 */
/**
 * ⚠ Memoized because it is asked tens of thousands of times per node, not as a
 * micro-optimization. Ten call sites across the hottest modules ask it, several
 * from INSIDE the coinductive escape proof, which re-enters per (path,
 * reference) -- and `spellsPrototypeHeritage` walks the whole function body on
 * every call. Measured unmemoized at 154 s of a 746 s three.js compile: 20.7%,
 * the single hottest frame in the program. The answer is a pure, deterministic
 * classification of an immutable AST node, so caching it by node identity
 * changes nothing but the repeated work.
 */
const constructorFunctions = new WeakMap<ts.Node, boolean>()

export const isConstructorFunction = (node: ts.Node): node is ts.FunctionDeclaration | ts.FunctionExpression => {
  const known = constructorFunctions.get(node)
  if (known !== undefined) return known
  const answer = computeIsConstructorFunction(node)
  constructorFunctions.set(node, answer)
  return answer
}

const computeIsConstructorFunction = (node: ts.Node): boolean => {
  if (!ts.isFunctionDeclaration(node) && !ts.isFunctionExpression(node)) return false
  const body = node.body
  if (!body) return false
  let writesThis = false
  for (const statement of body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression !== undefined && statement.expression.kind !== ts.SyntaxKind.ThisKeyword)
      return false
    if (!ts.isExpressionStatement(statement)) continue
    const expression = statement.expression
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(expression.left) &&
      expression.left.expression.kind === ts.SyntaxKind.ThisKeyword
    )
      writesThis = true
  }
  return writesThis && !spellsPrototypeHeritage(body)
}

/** `F.prototype = ...` or `B.call( this, ... )` / `B.apply( this, ... )` anywhere in the body. */
const spellsPrototypeHeritage = (body: ts.Block): boolean => {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    const parent = node.parent
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'prototype' &&
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.left === node
    )
      found = true
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'call' || node.expression.name.text === 'apply') &&
      node.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword
    )
      found = true
    ts.forEachChild(node, visit)
  }
  visit(body)
  return found
}

export interface ValueFlowIndex {
  /** The build's strict-mode input, shared by every inference and production consumer. */
  readonly buildIsStrict: boolean
  readonly calls: readonly FlowCallSite[]
  /** `calls` keyed by its call node. Three walks scanned the list linearly per
   * (call, body) pair to answer this, which is quadratic in a program's call
   * count and was invisible until the single graph started asking per query. */
  readonly callSiteOf: (call: ts.CallExpression | ts.NewExpression) => FlowCallSite | undefined
  /** `allWrites` keyed by `site`. Asked per reference inside the closed-use
   * walk, where a linear scan of every write in the program is the shape that
   * turns a proof into minutes. */
  readonly writesAtSite: (site: ts.Node) => readonly ValueWrite[]
  /** Reachable runtime property reads and writes from the same source walk. */
  readonly propertyAccesses: readonly (ts.PropertyAccessExpression | ts.ElementAccessExpression)[]
  /**
   * Reachable binding elements, from the same walk.
   *
   * A binding element READS a slot of the object being taken apart, exactly as
   * a property access does, and a consumer enumerating "everything that can
   * read this key" has to see both. `propertyAccesses` alone made
   * `const { app } = p` invisible to that enumeration, so a value reached only
   * by destructuring had a closure proof with a hole in it -- the reason the
   * two spellings of one read must be inventoried together rather than by
   * whoever remembers to look for patterns.
   */
  readonly bindingPatternReads: readonly ts.BindingElement[]
  /** Literal Array allocations in the same reachable discovery walk, including discarded and direct-call values. */
  readonly arrayLiterals: readonly ts.ArrayLiteralExpression[]
  /** Reachable source classes, including classes with no visible construction. */
  readonly classDeclarations: readonly SourceClass[]
  /**
   * Every member name declared by a reachable `get`/`set` accessor -- on a
   * class, or in an object literal.
   *
   * A consumer reasoning about what a member SLOT can hold has to be able to
   * tell a stored slot from an accessor, because an accessor's value is
   * whatever its body returns and NO write in this index records it. Collected
   * in the same reachable walk as `classDeclarations` so no consumer has to
   * re-traverse for it, and so an object-literal getter -- which a
   * class-declaration scan would miss entirely -- is seen.
   */
  readonly accessorNames: ReadonlySet<string>
  /**
   * Whether any reachable accessor's name is COMPUTED, so `accessorNames` is
   * incomplete and a consumer asking about member slots must refuse outright.
   */
  readonly hasComputedAccessorName: boolean
  /** Lexical receiver mentions (`this` and `super`) keyed by their actual non-arrow callable or class-field owner. */
  readonly receiverReferencesToDeclaration: (declaration: ts.Node) => readonly ReceiverReference[]
  /** The exact lexical owner recorded for an indexed `this` or `super` token. */
  readonly receiverOwnerOf: (reference: ts.Node) => ts.Node | null
  /** Whether this index traversed the executable body of this callable declaration. */
  readonly callableBodyIsIndexed: (declaration: ts.Node) => boolean
  /** Exact member-name references, including private names; used for callable escape and narrowing evidence. */
  readonly memberReferencesToSymbol: (symbol: ts.Symbol) => readonly ts.MemberName[]
  /** The cell an expression names, or `null` when it names none this layer can resolve. */
  readonly targetOf: (expression: ts.Expression) => FlowTarget | null
  /** Every write whose target resolved to this symbol, at the naming expression (`FlowTarget.symbol`). */
  readonly writesToSymbol: (symbol: ts.Symbol) => readonly ValueWrite[]
  /** Every write whose target resolved to this declaration node (`FlowTarget.declaration`). */
  readonly writesToDeclaration: (declaration: ts.Node) => readonly ValueWrite[]
  /** Every write elsewhere whose VALUE expression names this cell -- where this cell's value flows TO. */
  readonly flowsFromDeclaration: (declaration: ts.Node) => readonly ValueWrite[]
  /** Every write elsewhere whose VALUE expression names this symbol. */
  readonly flowsFromSymbol: (symbol: ts.Symbol) => readonly ValueWrite[]
  /**
   * Every expression in the program that NAMES this cell, in any position --
   * a read, a write target, a callee, a declaration's own name.
   *
   * The completeness question a value-flow consumer actually has is negative:
   * "is there a mention of this cell I cannot explain?" Answering it needs the
   * mentions, not the writes, and every census that has ever asked it built a
   * private identifier index to do so (`parameter-bindings.ts`'s
   * `referencesBySymbol`) -- keyed on identifiers only, so a member reached as
   * `o.p` was invisible to it. Recorded here under ALL THREE of a
   * `FlowTarget`'s keys (see `FlowTarget`), deliberately over-approximating:
   * an extra mention can only make a consumer refuse, never make it answer.
   */
  readonly referencesToSymbol: (symbol: ts.Symbol) => readonly ts.Expression[]
  /** Every expression naming the cell whose stable key is this declaration node. */
  readonly referencesToDeclaration: (declaration: ts.Node) => readonly ts.Expression[]
  /** Every write this index holds, in source order -- for a consumer that must consider the whole edge set rather than one cell's. */
  readonly allWrites: readonly ValueWrite[]
  /** How many writes of each edge kind this index holds, for measurement. */
  readonly edgeCounts: ReadonlyMap<FlowEdgeKind, number>
  /** Total writes indexed. */
  readonly writeCount: number
}

const NO_WRITES: readonly ValueWrite[] = []
const NO_REFERENCES: readonly ts.Expression[] = []

/** An index over no program, for callers that state none. */
export const emptyValueFlowIndex: ValueFlowIndex = {
  buildIsStrict: false,
  receiverReferencesToDeclaration: () => [],
  receiverOwnerOf: () => null,
  callableBodyIsIndexed: () => false,
  calls: [],
  callSiteOf: () => undefined,
  writesAtSite: () => NO_WRITES,
  propertyAccesses: [],
  bindingPatternReads: [],
  classDeclarations: [],
  arrayLiterals: [],
  accessorNames: new Set(),
  hasComputedAccessorName: false,
  memberReferencesToSymbol: () => [],
  targetOf: () => null,
  writesToSymbol: () => NO_WRITES,
  writesToDeclaration: () => NO_WRITES,
  flowsFromDeclaration: () => NO_WRITES,
  flowsFromSymbol: () => NO_WRITES,
  referencesToSymbol: () => NO_REFERENCES,
  referencesToDeclaration: () => NO_REFERENCES,
  allWrites: NO_WRITES,
  edgeCounts: new Map(),
  writeCount: 0
}
