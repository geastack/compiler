import ts from 'typescript'

/**
 * What a program reaches from the files it was asked to compile.
 *
 * A project's file set is not its module graph. `include` names every file a
 * *typechecker* should see; what an application does is what its entry points
 * import, and nothing else runs. Compiling the first as though it were the
 * second is how an app that imports `Display` and `mount` acquires the
 * obligations of a camera it never opens: `runtime/host.ts` is one file, so
 * the whole of it -- `Camera`'s four `Promise.resolve` calls, `imageHost`'s
 * `GeaEmbeddedImage` boundary -- arrives alongside the two bindings the app
 * actually asked for.
 *
 * This is the one place that difference is decided. Every census downstream
 * walks the statements this hands it rather than the file it hands them for,
 * so there is one answer to "is this code in the program" instead of four that
 * can drift apart.
 *
 * Nothing here changes what anything *means*. The checker still sees the whole
 * project, so every type resolves exactly as it did and every layout is still
 * expanded from the checker's own answer -- a declaration this drops is
 * dropped from the *census*, not from the type system. That is what makes the
 * pruning safe to state at one seam: the stages after normalize cannot tell
 * that it happened, because the program they are handed simply does not
 * contain the code, and obligations, certification, lowering and emission all
 * read that one graph.
 *
 * ## What it refuses to prune
 *
 * The rule is not "unreferenced code is dead". A module's top level *runs* on
 * import, so a statement that performs an action -- a call, an assignment, an
 * `if`, an `export default` expression, a bare expression statement -- stays
 * whether or not anything reads what it produced. Exactly three declaration
 * forms are ever dropped, each because its own evaluation is provably not an
 * action:
 *
 * - A **function declaration**. Its evaluation is `InstantiateFunctionObject`:
 *   a closure is created and bound. Nothing observable happens, and the body
 *   does not run.
 * - A **class declaration** with no decorators, no `extends` clause, no static
 *   block, no static field initializer and no computed member name.
 *   `ClassDefinitionEvaluation` for such a class evaluates nothing at all, and
 *   this compiler lowers class evaluation to *no runtime step at all*
 *   (`ir/lower.ts`, `case 'class-lifecycle'`): the struct and the construct
 *   function it emits already are the layout the definition events record. A
 *   static block or a static initializer is the opposite -- each is a real
 *   region with a body -- so a class carrying one is kept; so is a class with
 *   a heritage clause, whose one definition-time step (the heritage read) is
 *   the event the projection takes the struct's base from (see
 *   `classDefinitionIsInert`).
 * - A **variable statement** whose every declarator binds a plain name and has
 *   either no initializer or an initializer drawn from `initializerIsInert`'s
 *   whitelist: literals, function/arrow/class expressions, and object/array
 *   literals built from those. Anything that could call something -- a call, a
 *   `new`, a property read (which can be a getter), a template substitution
 *   (which can be a `toString`), a spread, an assignment, even a bare
 *   identifier read (which can be a temporal-dead-zone throw) -- is outside the
 *   whitelist, and the statement is kept.
 *
 * Everything else is kept unconditionally: imports, exports, `export default`,
 * expression statements, control flow, enums, namespaces, and every type-only
 * declaration. Type declarations cost nothing to keep -- `familyOf`
 * (`census.ts`) assigns no family to an interface or a type alias, so they
 * contribute no candidates either way -- and keeping them removes the whole
 * question of whether a record layout was pruned out from under a live value.
 *
 * ## The second granularity: a class member
 *
 * A live class is live whole as a DEFINITION -- its layout, its fields, its
 * constructor -- but a method body runs only when a dispatch names it, and a
 * dispatch has to name it. `C.m` resolves to one declaration, so a static
 * member is opened by symbol. An instance member cannot be: a structurally
 * typed parameter, a base-class reference and an interface-typed call all land
 * on a member the receiver's static type does not identify, and an override is
 * reached through the base's name. So an instance member is opened by KEY --
 * any spelling of its name in live code, on any receiver, opens every member
 * that answers that name on every class.
 *
 * This is the same cut `ir/shake.ts` makes over the lowered IR, and its own
 * header states the fact that makes the key comparison sound for this backend:
 * a class method or accessor is addressable only through a key spelled at
 * compile time, because `emit-properties.ts` refuses a dynamic key by name and
 * the two dynamic paths that do exist address record fields and a box's
 * expando, neither of which can answer a method key. What that pass could not
 * do from the IR is stop a refusal inside a dead body from denying the whole
 * program its certificate -- obligations are censused before lowering, so a
 * method nothing calls still had to be representable. That is the reason this
 * half of the cut lives here.
 *
 * A member reached through no spelling at all -- the gea plugin lowers
 * `instance.render(root, depth)` into a call to the class's own `template`
 * (`plugins/gea/render-bridge.ts`) -- is not something this walk can see, so
 * the host states its own such names instead: see `hostReachedMemberKeys`.
 *
 * ## Fail-closed everywhere it cannot see
 *
 * - No entry file resolves: nothing is pruned at all (`wholeProgram`).
 * - A reference resolves into a file this walk has not reached: that file is
 *   *promoted* to reachable rather than the reference dropped. A missed import
 *   edge, a global script file that nothing imports, a `declare global`
 *   augmentation -- each resurrects its file the moment anything names
 *   something in it.
 * - A reference is followed for **every** identifier in live code, in type
 *   position as well as value position, and through property names too. A
 *   property name resolves to the member of the type it was read off, so a
 *   structural read of a class member keeps that class. Over-marking costs
 *   dead code left in; under-marking is the only direction that could be
 *   wrong, so the walk is deliberately blunt.
 * - Only an import or a re-export is *not* traversed for references, because
 *   neither uses what it names: `export { mount } from './primitives'`
 *   re-exports a binding without reading it, and traversing one would make
 *   every barrel file mark its whole surface live -- which is precisely the
 *   state being removed. An importer that really does use the name resolves
 *   the alias chain to the same declaration and marks it here.
 */

export interface ProgramReachability {
  /** The top-level statements of `file` this program reaches, in source order. */
  readonly statementsOf: (file: ts.SourceFile) => readonly ts.Statement[]
  /**
   * Whether this node is an unused class member, or a constructor/initializer
   * whose class is retained only for its instance layout.
   *
   * The second granularity this module answers at, and the only one below a
   * statement. A class is opened whole because its DEFINITION is what a live
   * reference reaches -- but a method's body is not part of that definition: it
   * runs when a dispatch names it. So a method is exactly as prunable as a
   * top-level function declaration, and for the same reason.
   *
   * A static is named by symbol (`C.m` resolves to one declaration) and an
   * instance member by key (a dispatch's receiver does not say which class's
   * member it lands on). See this module's header.
   */
  readonly memberIsPruned: (node: ts.Node) => boolean
  readonly classIsLayoutOnly: (node: ts.ClassDeclaration) => boolean
}

/**
 * Every statement of every file: the answer when nothing may be pruned.
 *
 * This is the fail-closed value, and it is what a compilation whose entry
 * points could not be resolved gets. It is deliberately not the default of any
 * parameter -- a census that silently walked the whole program because someone
 * forgot to thread the reachability through would be the second authority this
 * module exists to prevent.
 */
export const wholeProgram: ProgramReachability = {
  statementsOf: (file) => file.statements,
  memberIsPruned: () => false,
  classIsLayoutOnly: () => false
}

/**
 * `ts.forEachChild(file, visit)` restricted to what the program reaches.
 *
 * Every census in the parameter-binding family walks a file this way, and a
 * walk that still visited a pruned statement counted references in code the
 * program never runs: test262's propertyHelper ends with the inert, unreached
 * `var verifyPrimordialProperty = verifyProperty`, and that one alias made
 * the parameter census refuse `verifyProperty` as "escaping" -- so its `obj`
 * never learned it is only ever called with `Math`, and every helper under it
 * went dynamic. A declaration file has no statements the program evaluates,
 * the same exclusion the walks made for themselves before.
 */
export const forEachReachableStatement = (reachable: ProgramReachability, file: ts.SourceFile, visit: (node: ts.Node) => void): void => {
  if (file.isDeclarationFile) return
  for (const statement of reachable.statementsOf(file)) visit(statement)
}

const liveStatementSets = new WeakMap<ProgramReachability, Map<ts.SourceFile, ReadonlySet<ts.Statement>>>()

/**
 * Whether `node` is code the program runs: inside a top-level statement this
 * program reaches, and under no member it pruned -- the boundary
 * `forEachReachableStatement` draws for a walk, asked of one node a walk did
 * not produce. A module the checker loaded but the program never evaluates
 * (three's `ColorSpaceNode.js`, pulled in beside the node materials) answers
 * false everywhere.
 */
export const nodeIsReachable = (reachable: ProgramReachability, node: ts.Node): boolean => {
  let current = node
  while (current.parent && !ts.isSourceFile(current.parent)) {
    if (reachable.memberIsPruned(current)) return false
    current = current.parent
  }
  const file = current.parent
  if (!file || !ts.isSourceFile(file) || file.isDeclarationFile) return false
  let perFile = liveStatementSets.get(reachable)
  if (!perFile) liveStatementSets.set(reachable, (perFile = new Map()))
  let statements = perFile.get(file)
  if (!statements) perFile.set(file, (statements = new Set(reachable.statementsOf(file))))
  return statements.has(current as ts.Statement)
}

export interface ReachabilityInput {
  readonly checker: ts.TypeChecker
  /** The files this compiler is responsible for -- `CompiledProgram.sourceFiles`. */
  readonly files: readonly ts.SourceFile[]
  /** The files the caller named. Empty means the entry points are unknown, and nothing is pruned. */
  readonly entries: readonly ts.SourceFile[]
  /**
   * Member names a HOST reaches without the program spelling them.
   *
   * The gea plugin lowers `instance.render(root, depth)` into a call to the
   * class's own `template` member (`plugins/gea/render-bridge.ts`), which no
   * TypeScript source names -- so nothing in this walk could ever see it
   * spelled, and the member-key rule below would drop the one body the bridge
   * calls. A plugin states its own such names (`PluginCapabilities`'
   * `reachedMemberKeys`) rather than this file knowing any of them: which
   * members a host reaches is the host's fact, and a name hard-coded here
   * would be gea behaviour living in the generic compiler.
   */
  readonly hostReachedMemberKeys?: ReadonlySet<string>
}

/**
 * Whether a computed member name is a key the class definition can compute
 * without performing an action.
 *
 * One shape qualifies: a WELL-KNOWN SYMBOL -- `[Symbol.dispose]`,
 * `[Symbol.asyncIterator]`. Two facts make it safe, and both are checked.
 * Its type is `unique symbol`, which TypeScript mints only for a declared
 * constant, so the key is a value and not a computation; and every declaration
 * of the object it is read from is ambient, so the read is of the language's
 * own intrinsic rather than of a user object where `get` could run code.
 *
 * Without this, `class X { [Symbol.dispose]() {} }` was kept in every program
 * that so much as imported its module -- and node-compat's `events.ts` has two
 * such classes, whose bodies need a deferred `Promise` this runtime does not
 * have.
 */
const computedKeyIsInert = (checker: ts.TypeChecker, name: ts.ComputedPropertyName): boolean => {
  // STATED, not HOLDS -- and deliberately left alone. This asks whether
  // `name.expression` denotes a well-known ambient symbol (`Symbol.dispose`,
  // `Symbol.asyncIterator`) via the checker's own `UniqueESSymbol` flag, to
  // decide whether a class's computed-key EVALUATION can be pruned. No
  // parameter/local/return/field census tracks a well-known-symbol reference
  // (it is neither a parameter, an assignment target, nor a call result), so
  // `censusedTypeAt` would fall through to this exact checker call every
  // time -- but this file is a REACHABILITY/pruning decision, not a boxing
  // one: a wrong answer here drops or keeps a statement, not a carrier
  // (a mis-derived `never` here has miscompiled live code before). No boxing upside, real correctness downside -- left as a
  // direct checker call.
  if ((checker.getTypeAtLocation(name.expression).flags & ts.TypeFlags.UniqueESSymbol) === 0) return false
  const root = ts.isPropertyAccessExpression(name.expression) ? name.expression.expression : name.expression
  const declarations = checker.getSymbolAtLocation(root)?.declarations ?? []
  return declarations.length > 0 && declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)
}

/** Whether a class's *definition* evaluates anything beyond binding its own name. */
const classDefinitionIsInert = (checker: ts.TypeChecker, node: ts.ClassLikeDeclaration): boolean => {
  if (ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0) return false
  // The one step `ClassDefinitionEvaluation` performs for a decorator-free
  // class is its heritage read, and that step is not inert in THIS compiler
  // even though it calls nothing: `projection/classes.ts` reads a class's
  // `base` link off the class-lifecycle heritage event the census publishes
  // for the definition, and `records.ts` spells `struct D : B` from that
  // link alone -- while the struct itself is emitted whenever the class's
  // shape is reachable, which a type position keeps it. Pruning an
  // un-instantiated `class One extends Base` whose type still names a union
  // arm emitted `struct One final {}` with no base, and the upcast
  // `Ref<Base>(Ref<One>)` the union's recast renders stopped compiling.
  if (node.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)) return false
  return node.members.every((member) => {
    if (ts.canHaveDecorators(member) && (ts.getDecorators(member)?.length ?? 0) > 0) return false
    // A static block is a body that runs at definition time, and a computed key
    // is an expression evaluated there -- for an instance field as much as a
    // static one, because the key is captured when the class is defined.
    if (ts.isClassStaticBlockDeclaration(member)) return false
    if (member.name && ts.isComputedPropertyName(member.name) && !computedKeyIsInert(checker, member.name)) return false
    if (!ts.isPropertyDeclaration(member)) return true
    const isStatic = member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false
    return !isStatic || member.initializer === undefined
  })
}

/**
 * Whether this class member's body runs only when something NAMES it.
 *
 * A method or accessor, with no decorator and no computed name. Each exclusion
 * is a way the member is reached other than by its own name: a decorator
 * receives it at class-definition time, and a computed name is an expression
 * evaluated there. A FIELD is excluded too -- by not being a method at all --
 * because an instance initializer runs at construction and a static one at
 * definition.
 *
 * Static and instance members are both deferrable, but they are opened by two
 * different questions, because they are reached two different ways. `C.m`
 * resolves to one declaration, so a static is opened by SYMBOL. An instance
 * member is reached by dispatch through a receiver whose runtime class the
 * walk does not know -- `base.close()` on a value that is really a subclass
 * runs the subclass's `close` -- so an instance member is opened by KEY: any
 * spelling of the name anywhere in live code opens every member that answers
 * it, on every class. See `memberKeyOf`.
 */
const memberIsDeferrable = (member: ts.Node): member is ts.MethodDeclaration | ts.AccessorDeclaration => {
  if (!ts.isMethodDeclaration(member) && !ts.isGetAccessorDeclaration(member) && !ts.isSetAccessorDeclaration(member)) return false
  // A CLASS member only. An object literal spells the same three node kinds --
  // `{ m() {}, get v() {} }` really is a `MethodDeclaration` and an accessor --
  // but its members are not dispatched-to definitions held on a prototype, they
  // are the object's own installed properties: evaluating the literal creates
  // each one, so nothing has to name a member for it to exist. Deferring one
  // dropped the property from the object entirely (`object-members.ts`,
  // `object-literal-accessors.ts`, both of which lost their certificate), which
  // is the failure mode a static modifier used to rule out by accident.
  if (!member.parent || !ts.isClassLike(member.parent)) return false
  if (ts.getDecorators(member)?.length) return false
  return !ts.isComputedPropertyName(member.name)
}

const memberIsStatic = (member: ts.Node): boolean =>
  ts.canHaveModifiers(member) && (ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false)

/**
 * The name an instance member is dispatched under, or `null` when it has none
 * this walk can compare against a spelling.
 *
 * A computed name never reaches here (`memberIsDeferrable` refuses one), so the
 * remaining forms are all written text. `null` is the fail-closed answer and
 * keeps the member.
 */
const memberKeyOf = (member: ts.MethodDeclaration | ts.AccessorDeclaration): string | null => {
  const name = member.name
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

/**
 * Member names the language invokes on a value without the program spelling
 * one, so no spelling can be required before keeping them.
 *
 * The same set `ir/shake.ts` keeps for the identical reason, and it has to stay
 * the same set: that pass makes the same cut over the lowered IR, and a name
 * only one of the two protects is a member this walk drops and that walk
 * expected to still be there.
 */
const specificationInvokedKeys: ReadonlySet<string> = new Set(['toString', 'valueOf', 'then', 'next', 'return', 'throw'])

/** Whether an object literal member installs itself without evaluating anything but its own definition. */
/** Whether a declaration is a name this module IMPORTED rather than one it declares itself. */
const isImportedBinding = (declaration: ts.Declaration): boolean =>
  ts.isImportSpecifier(declaration) ||
  ts.isImportClause(declaration) ||
  ts.isNamespaceImport(declaration) ||
  ts.isImportEqualsDeclaration(declaration)

const objectMemberIsInert = (checker: ts.TypeChecker, member: ts.ObjectLiteralElementLike): boolean => {
  if (member.name && ts.isComputedPropertyName(member.name)) return false
  // A method or accessor is a function definition: its body does not run here,
  // and its default parameter values run at call time, not at definition.
  if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) return true
  // `{ x }` reads the binding `x`, and the whitelist below refuses a bare
  // identifier because the read can throw a `ReferenceError` from a temporal
  // dead zone that TypeScript does not report ACROSS AN IMPORT CYCLE. That
  // reason is specific, and so is its converse: a shorthand naming a binding
  // declared in THIS file is a read TypeScript checks itself (TS2448), and a
  // program it rejects is one this compiler never compiles. So the read is
  // provably not an action, and the object literal it sits in can be dropped
  // when nothing names it.
  //
  // What this buys: node-compat's `events.ts` ends with a CommonJS-style
  // namespace listing every export by shorthand. Kept, it made `once` and the
  // async-iterator machinery live in every program that imports the module at
  // all -- and those need a deferred `Promise` this runtime deliberately does
  // not have, so an app that never calls them could not compile.
  if (ts.isShorthandPropertyAssignment(member)) {
    const declarations = checker.getShorthandAssignmentValueSymbol(member)?.declarations ?? []
    if (declarations.length === 0) return false
    return declarations.every((declaration) => declaration.getSourceFile() === member.getSourceFile() && !isImportedBinding(declaration))
  }
  // `{ ...rest }` copies own enumerable properties, which reads them -- and a
  // read can be a getter.
  if (!ts.isPropertyAssignment(member)) return false
  return initializerIsInert(checker, member.initializer)
}

/**
 * Whether evaluating this initializer is provably not an action.
 *
 * The whitelist is short on purpose. Every form outside it is kept, and the
 * cost of keeping one is dead code in the census -- while the cost of
 * admitting one wrongly is a module initialization step that silently stopped
 * happening. A bare identifier is outside it for that reason and not because
 * reading a binding does work: the read can throw a `ReferenceError` from a
 * temporal dead zone, and while TypeScript reports that itself within one
 * module (TS2448, which this compiler refuses the program for), it does not
 * across an import cycle.
 */
const initializerIsInert = (checker: ts.TypeChecker, node: ts.Expression): boolean => {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
    return initializerIsInert(checker, node.expression)
  if (ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) return initializerIsInert(checker, node.expression)
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true
  if (ts.isClassExpression(node)) return classDefinitionIsInert(checker, node)
  if (ts.isObjectLiteralExpression(node)) return node.properties.every((member) => objectMemberIsInert(checker, member))
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((element) => ts.isOmittedExpression(element) || initializerIsInert(checker, element))
  }
  // A bare identifier naming a binding THIS FILE declares -- test262's
  // propertyHelper ends with `var verifyPrimordialProperty = verifyProperty`.
  // The one observable effect an identifier read can have is a
  // temporal-dead-zone throw, and the shorthand case above already states why
  // that is provably absent within one file: TypeScript reports it itself
  // (TS2448) and refuses the program. A function declaration cannot even be in
  // a dead zone. Kept live, that alias counted as `verifyProperty` ESCAPING to
  // a value position (`parameter-bindings.ts`'s `escapeReason`), which refused
  // every call-site type its parameters would otherwise have carried.
  if (ts.isIdentifier(node)) {
    const declarations = checker.getSymbolAtLocation(node)?.declarations ?? []
    if (declarations.length === 0) return false
    return declarations.every((declaration) => declaration.getSourceFile() === node.getSourceFile() && !isImportedBinding(declaration))
  }
  // `C.prototype` where `C` is a class THIS FILE declares. ECMA-262 10.2.4
  // makes `prototype` a non-writable, non-configurable DATA property of every
  // class constructor, so the read this whitelist otherwise refuses -- because
  // a property read can be a getter -- provably is not one here. The class
  // has to be declared in this file for the same reason a shorthand's binding
  // does: a temporal-dead-zone throw across an import cycle is the one
  // observable effect an identifier read can have, and TypeScript reports the
  // within-a-file case itself.
  //
  // `events.ts` exports `prototype = EventEmitter.prototype` as a CommonJS
  // compatibility shim. This runtime models no prototype object at all, so
  // emitting that read has no right answer -- and pruning a statement nothing
  // reads is the answer that does not invent one.
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'prototype' && ts.isIdentifier(node.expression)) {
    const declarations = checker.getSymbolAtLocation(node.expression)?.declarations ?? []
    return (
      declarations.length > 0 &&
      declarations.every((declaration) => ts.isClassDeclaration(declaration) && declaration.getSourceFile() === node.getSourceFile())
    )
  }
  if (ts.isCallExpression(node)) return closureFactoryCallIsInert(checker, node)
  // `-1` and `+1` are how a negative numeric constant is spelled; nothing else
  // unary is admitted, because every other operand form can reach user code.
  if (ts.isPrefixUnaryExpression(node)) {
    const signed = node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken
    return signed && (ts.isNumericLiteral(node.operand) || ts.isBigIntLiteral(node.operand))
  }
  return (
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isRegularExpressionLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  )
}

/**
 * The body of a function whose call does nothing but create and return a
 * closure: `return <function>` and nothing else, over plain parameters with no
 * default. Calling it binds the parameters and allocates the closure; no
 * expression runs, so the parameters are only ever READ later, by the closure,
 * when something calls it.
 */
const returnsOnlyAClosure = (callee: ts.SignatureDeclaration): boolean => {
  if (!ts.isFunctionDeclaration(callee) && !ts.isFunctionExpression(callee) && !ts.isArrowFunction(callee)) return false
  if (callee.asteriskToken || ts.getCombinedModifierFlags(callee) & ts.ModifierFlags.Async) return false
  if (callee.parameters.some((parameter) => !ts.isIdentifier(parameter.name) || parameter.initializer !== undefined)) return false
  const body = callee.body
  if (!body) return false
  let returned: ts.Expression | undefined
  if (ts.isBlock(body)) {
    const [only, ...rest] = body.statements
    if (!only || rest.length > 0 || !ts.isReturnStatement(only)) return false
    returned = only.expression
  } else returned = body
  while (
    returned &&
    (ts.isParenthesizedExpression(returned) ||
      ts.isAsExpression(returned) ||
      ts.isSatisfiesExpression(returned) ||
      ts.isNonNullExpression(returned) ||
      ts.isTypeAssertionExpression(returned))
  )
    returned = returned.expression
  return returned !== undefined && (ts.isArrowFunction(returned) || ts.isFunctionExpression(returned))
}

/** Every module `file` evaluates, transitively, itself excluded unless a cycle leads back to it. */
const transitiveModuleTargetsOf = (checker: ts.TypeChecker, file: ts.SourceFile): ReadonlySet<ts.SourceFile> => {
  const seen = new Set<ts.SourceFile>()
  const pending = [...moduleTargetsOf(checker, file)]
  while (pending.length > 0) {
    const next = pending.pop()!
    if (seen.has(next)) continue
    seen.add(next)
    pending.push(...moduleTargetsOf(checker, next))
  }
  return seen
}

/**
 * `export const upgradeWebSocket = defineWebSocketHelper(async (c, events) =>
 * {...})` -- a call whose whole effect is a closure over inert arguments.
 *
 * `@hono/node-server` re-exports `upgradeWebSocket` from its package entry, so
 * every app that imports `serve` evaluates `websocket.ts`, and a call is an
 * action the statement rule keeps. But hono's `defineWebSocketHelper` only
 * returns an arrow closing over `handler`; the handler runs when that arrow is
 * called, and the arrow lives in `upgradeWebSocket` alone. So this is the
 * `const X = () => ...` the whitelist already drops, reached through one call.
 *
 * The callee must be one declaration this program compiles, whose body
 * `returnsOnlyAClosure` proves runs nothing, and its name must be readable
 * without a temporal-dead-zone throw: declared in this file (TypeScript
 * reports a same-file use before declaration, TS2448), or imported from a
 * module that cannot import this one back and so has finished evaluating.
 */
const closureFactoryCallIsInert = (checker: ts.TypeChecker, node: ts.CallExpression): boolean => {
  if (node.questionDotToken || !ts.isIdentifier(node.expression)) return false
  if (!node.arguments.every((argument) => !ts.isSpreadElement(argument) && initializerIsInert(checker, argument))) return false
  const symbol = checker.getSymbolAtLocation(node.expression)
  if (!symbol) return false
  const imported = (symbol.flags & ts.SymbolFlags.Alias) !== 0
  const target = imported ? checker.getAliasedSymbol(symbol) : symbol
  const declarations = target.declarations ?? []
  if (declarations.length !== 1) return false
  const declaration = declarations[0]!
  const file = declaration.getSourceFile()
  if (file.isDeclarationFile) return false
  let callee: ts.Node | undefined = declaration
  if (ts.isVariableDeclaration(declaration)) {
    const list = declaration.parent
    if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return false
    callee = declaration.initializer
    while (callee && (ts.isParenthesizedExpression(callee) || ts.isAsExpression(callee) || ts.isSatisfiesExpression(callee)))
      callee = callee.expression
  }
  if (!callee || !ts.isFunctionLike(callee) || !returnsOnlyAClosure(callee)) return false
  const here = node.getSourceFile()
  if (file === here) return !imported
  return imported && ts.isExternalModule(file) && !transitiveModuleTargetsOf(checker, file).has(here)
}

/** Whether this top-level statement may be dropped when nothing reaches what it declares. */
const isPrunableDeclaration = (checker: ts.TypeChecker, statement: ts.Statement): boolean => {
  // `export default x` in a module that is NOT an entry declares a name and
  // runs nothing: the initializer is an identifier the module already
  // evaluated, so opening the export is opening a NAME, and a name nothing
  // imports is dead in a whole-program compile. Entries are exempt above --
  // `openStatement` is called unconditionally for them -- which is what keeps
  // a library's own default export a root when the library IS the program.
  //
  // Without this, node-compat's `events.ts` kept its whole CommonJS-style
  // default namespace alive, and with it `once`, `on` and the async-iterator
  // machinery, in an application that imports only `node:http` -- five
  // capabilities demanded by code no call in the program can reach.
  if (ts.isExportAssignment(statement)) return true
  if (ts.isFunctionDeclaration(statement)) {
    return !(ts.canHaveDecorators(statement) && (ts.getDecorators(statement)?.length ?? 0) > 0)
  }
  if (ts.isClassDeclaration(statement)) return classDefinitionIsInert(checker, statement)
  if (!ts.isVariableStatement(statement)) return false
  return statement.declarationList.declarations.every((declaration) => {
    // A binding pattern reads properties off the initializer, and a read can be
    // a getter or a throw on `null`; only a plain name binds without acting.
    if (!ts.isIdentifier(declaration.name)) return false
    return declaration.initializer === undefined || initializerIsInert(checker, declaration.initializer)
  })
}

/** The source files a module's own import and re-export declarations name. */
const moduleTargetsOf = (checker: ts.TypeChecker, file: ts.SourceFile): readonly ts.SourceFile[] => {
  const targets: ts.SourceFile[] = []
  const add = (specifier: ts.Expression | undefined): void => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return
    // The checker's own module resolution, not this walk's: an unresolvable
    // specifier is a checker error, and a program the checker rejects is one
    // this compiler already refuses before anything here matters.
    for (const declaration of checker.getSymbolAtLocation(specifier)?.declarations ?? []) {
      if (ts.isSourceFile(declaration)) targets.push(declaration)
    }
  }
  const visit = (node: ts.Node): void => {
    // `import type { Context } from 'hono'` is ERASED: it emits nothing, so the
    // module it names never evaluates and nothing in it is reachable through
    // this edge. Counting it made an app that wants one TYPE from a barrel
    // pull in every module the barrel re-exports -- hono's `index.ts` reaches
    // `RegExpRouter`, `TrieRouter` and `SmartRouter`, none of which
    // `hono/tiny` uses, and their generic bodies accounted for 33 of the
    // program's mandatory obligations. A module imported for a value ANYWHERE
    // else is still reached by that edge; this drops only the edge that
    // carries no evaluation.
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.isTypeOnly !== true) add(node.moduleSpecifier)
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly) add(node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      add(node.moduleReference.expression)
    // A dynamic `import()` is an edge whether or not the call ever runs: this
    // over-approximates rather than tying module reachability to control flow.
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  return targets
}

/** Every declaration a name can mean, the target of an alias chain included. */
const declarationsOf = (checker: ts.TypeChecker, symbol: ts.Symbol): readonly ts.Declaration[] => {
  const own = symbol.declarations ?? []
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return own
  // `getAliasedSymbol` resolves the whole chain, which is what a barrel needs:
  // an app's `import { Display } from '@geastack/core'` passes through
  // `runtime.ts`'s `export *` and `runtime-surface.ts`'s `export *` before it
  // reaches the declaration in `runtime/host.ts`.
  const target = checker.getAliasedSymbol(symbol)
  return target === symbol ? own : [...own, ...(target.declarations ?? [])]
}

/**
 * The order this program's modules evaluate in, as ECMA-262 defines it.
 *
 * A module body RUNS, once, when the module graph is evaluated -- and the
 * order is not an implementation detail a target may pick: `InnerModuleEvaluation`
 * (16.2.1.5.3) evaluates a module's requested modules, in the order the
 * `[[RequestedModules]]` list names them, BEFORE the module's own body. So a
 * module observes the state its imports established, and every import of a
 * module after the first is a no-op. That is post-order over the import graph
 * from the entry points, and a compiler that emitted the bodies in file order,
 * or in whatever order a map happened to iterate, would produce a program
 * whose module state is built in the wrong order -- constants read before the
 * module that assigns them ran.
 *
 * A cycle terminates the same way the spec's does: a module already being
 * evaluated is not re-entered, so its body runs once and the importer that
 * closed the cycle observes it partially initialized. That is the language's
 * answer, not an approximation of it.
 *
 * Files outside this compilation are skipped, exactly as `censusReachability`
 * skips them: a `.d.ts` declares and evaluates nothing, and a file this
 * compiler is not responsible for has no body to run.
 *
 * A SCRIPT is not in that graph at all and runs FIRST. A file with no
 * top-level `import`/`export` is a Script, not a Module (16.1 vs 16.2): its
 * top-level declarations go into the global scope, so no module can name it in
 * `[[RequestedModules]]` and the post-order walk above can never reach it --
 * yet every module can see what it declared. The only order consistent with
 * that is all scripts before any module, which is also the order a host
 * evaluates them in. node-compat's `runtime/node/globals.ts` is one: it
 * declares `Request`/`Response`/`Headers`/`URL` into the global scope for
 * library code that constructs them by name, and without this its class
 * objects were left value-initialized -- hono's `new Request(...)` jumped
 * through a null constructor thunk on the first served request.
 */
/**
 * Whether a source file evaluates anything at all.
 *
 * `export {}` followed by `declare global { ... }` is the shape of an ambient
 * module: it exists to put names into the checker's global scope and lowers
 * no body, exactly like a `.d.ts` -- it only carries a `.ts` extension so the
 * project can name it as a real root when a stated module set filters the
 * staged project's file list down to declarations (node-compat's
 * `standard-library.ts`, `node-globals.ts`). Scheduling such a file as a
 * module body would ask the entry to call a function nothing defines, which
 * the printer refuses rather than skips (`entryDefinitionOf`).
 *
 * Only statements with NO runtime meaning qualify: `declare`d declarations,
 * interfaces, type aliases, type-only imports, and an export declaration that
 * names nothing (`export {}`) or re-exports types only. Any other statement --
 * a class, a `const`, a call, a real `export` -- and the file evaluates.
 */
const evaluatesNothing = (file: ts.SourceFile): boolean =>
  file.statements.every((statement) => {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return true
    if (ts.isImportDeclaration(statement)) return statement.importClause?.isTypeOnly === true
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) return true
      if (statement.moduleSpecifier !== undefined) return false
      return statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.length === 0
    }
    return ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
  })

export const moduleEvaluationOrder = (input: ReachabilityInput): readonly ts.SourceFile[] => {
  const compiled = new Set(input.files)
  const order: ts.SourceFile[] = []
  const started = new Set<ts.SourceFile>()
  const visit = (file: ts.SourceFile): void => {
    if (!compiled.has(file) || started.has(file)) return
    started.add(file)
    for (const target of moduleTargetsOf(input.checker, file)) visit(target)
    if (evaluatesNothing(file)) return
    order.push(file)
  }
  for (const file of input.files) if (!ts.isExternalModule(file) && !file.isDeclarationFile) visit(file)
  for (const entry of input.entries) visit(entry)
  return order
}

export const censusReachability = (input: ReachabilityInput): ProgramReachability => {
  if (input.entries.length === 0) return wholeProgram
  const compiled = new Set(input.files)
  const entries = new Set(input.entries)
  const liveFiles = new Set<ts.SourceFile>()
  const liveStatements = new Set<ts.Statement>()
  // A receiver's static type requires layout, not evaluation of its module or
  // constructor. A later value reference can promote the same class to runtime.
  const layoutClasses = new Set<ts.ClassDeclaration>()
  // Every deferrable member the walk has SEEN, and the subset something has
  // NAMED. A member in the first and not the second is dead: the class it
  // belongs to is live, so the walk reached its declaration, and nothing in
  // live code named it -- `C.m` for a static, the member's own key for an
  // instance member.
  const deferredMembers = new Set<ts.Node>()
  const liveMembers = new Set<ts.Node>()
  // Every member name live code has spelled, and the deferred INSTANCE members
  // still waiting for one. Grown as the walk runs, never precomputed over the
  // file set: a name spelled only inside a body nothing reaches is not a name
  // this program spells, and precomputing would count it. That is the same
  // fixpoint-from-below `ir/shake.ts` grows its own key set by, and it
  // terminates for the same reason -- a key is only ever added.
  const spelledKeys = new Set<string>([...specificationInvokedKeys, ...(input.hostReachedMemberKeys ?? [])])
  const pendingByKey = new Map<string, ts.Node[]>()
  const fileQueue: ts.SourceFile[] = [...input.entries]
  const memberQueue: ts.Node[] = []
  const statementQueue: ts.Statement[] = []
  const topLevel = new Map<ts.SourceFile, ReadonlySet<ts.Node>>()

  const topLevelOf = (file: ts.SourceFile): ReadonlySet<ts.Node> => {
    const known = topLevel.get(file)
    if (known) return known
    const built = new Set<ts.Node>(file.statements)
    topLevel.set(file, built)
    return built
  }

  const openStatement = (statement: ts.Statement, layoutOnly = false): void => {
    if (liveStatements.has(statement)) {
      if (!layoutOnly && ts.isClassDeclaration(statement) && layoutClasses.delete(statement)) statementQueue.push(statement)
      return
    }
    if (layoutOnly && ts.isClassDeclaration(statement)) layoutClasses.add(statement)
    liveStatements.add(statement)
    statementQueue.push(statement)
  }

  const openFile = (file: ts.SourceFile): void => {
    if (!compiled.has(file) || liveFiles.has(file)) return
    liveFiles.add(file)
    // An entry MODULE has no single call root -- a library's exports are its
    // roots and an application's top level is its body -- so it is kept whole
    // and only what it reaches is ever weighed. An entry SCRIPT (no top-level
    // `import`/`export`, ECMA-262 16.1) exports nothing: its roots are exactly
    // the statements that act, and a function declaration nothing in the
    // program names is as dead there as in any other file. Keeping a script
    // whole made every test262 case carry the obligations of the harness's
    // deprecated, never-called helpers (`verifyEqualTo`, `verifyWritable`, ...
    // in propertyHelper.js), whose unannotated parameters no call site ever
    // types -- a refusal inside a body no program reaches denied thousands of
    // cases their certificate.
    const whole = entries.has(file) && ts.isExternalModule(file)
    for (const statement of file.statements) if (whole || !isPrunableDeclaration(input.checker, statement)) openStatement(statement)
    for (const target of moduleTargetsOf(input.checker, file)) fileQueue.push(target)
  }

  const spellKey = (text: string): void => {
    if (spelledKeys.has(text)) return
    spelledKeys.add(text)
    const waiting = pendingByKey.get(text)
    if (!waiting) return
    pendingByKey.delete(text)
    for (const member of waiting) openMember(member)
  }

  const markSymbol = (symbol: ts.Symbol | undefined): void => {
    if (!symbol) return
    for (const declaration of declarationsOf(input.checker, symbol)) {
      if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) {
        let imported: ts.Node | undefined = declaration.parent
        while (imported && !ts.isSourceFile(imported) && !ts.isImportDeclaration(imported)) imported = imported.parent
        if (imported && ts.isImportDeclaration(imported)) {
          const module = input.checker.getSymbolAtLocation(imported.moduleSpecifier)
          for (const target of module?.declarations ?? []) if (ts.isSourceFile(target)) fileQueue.push(target)
        }
        // Reading an imported binding needs the imported module. The alias's
        // declaration does not execute every statement in its containing file.
        continue
      }
      // A value's property symbol can be declared by an imported interface
      // (`value.field`), even though this reference is in expression position.
      // Such a declaration provides a layout, never module evaluation.
      let owner: ts.Node | undefined = declaration
      while (owner && !ts.isSourceFile(owner) && !ts.isInterfaceDeclaration(owner) && !ts.isTypeAliasDeclaration(owner))
        owner = owner.parent
      if (owner && (ts.isInterfaceDeclaration(owner) || ts.isTypeAliasDeclaration(owner))) continue
      if (ts.isSourceFile(declaration)) {
        fileQueue.push(declaration)
        continue
      }
      const file = declaration.getSourceFile()
      if (!compiled.has(file)) continue
      let memberOwner: ts.Node | undefined = declaration.parent
      while (memberOwner && !ts.isSourceFile(memberOwner) && !ts.isClassDeclaration(memberOwner)) memberOwner = memberOwner.parent
      if (memberOwner && ts.isClassDeclaration(memberOwner) && !liveFiles.has(file)) {
        openStatement(memberOwner, true)
        if (memberIsDeferrable(declaration)) openMember(declaration)
        continue
      }
      // Naming something in a file this walk had not reached resurrects the
      // file, so a missed import edge or a global script costs precision and
      // never correctness.
      if (!liveFiles.has(file)) fileQueue.push(file)
      // Naming a deferrable static member is what makes its body live. The
      // class's own statement is opened either way by the walk below, which is
      // what keeps the LAYOUT of a class whose statics nothing calls intact.
      if (memberIsDeferrable(declaration)) openMember(declaration)
      let current: ts.Node = declaration
      while (current.parent && !ts.isSourceFile(current.parent)) current = current.parent
      if (current.parent && topLevelOf(file).has(current)) openStatement(current as ts.Statement)
    }
  }

  const markReference = (reference: ts.Identifier | ts.PrivateIdentifier): void => markSymbol(input.checker.getSymbolAtLocation(reference))

  /**
   * A member READ on a receiver typed as a class keeps that class's
   * definition, and only that.
   *
   * Type nodes are erased (see `markReferences`), and an inert class
   * definition -- no `extends`, no static body -- is prunable, so a class the
   * program names only in annotations was dropped whole. Its struct was still
   * emitted from the type table, which reads checker types independently of
   * this walk; but the member LAYOUT the emitter consults comes from the
   * class-lifecycle census over the statements this walk kept, so every read
   * of a member on such an instance refused at emission as "no class
   * evaluation published". Three's `Skeleton` is the shape: `SkinnedMesh`
   * names it in `@param {Skeleton}` and reads `skeleton.boneTexture`, and
   * nothing in an application without skinning ever constructs one.
   *
   * The trigger is the read, not the annotation. Opening every class a live
   * annotation names was measured: three's JSDoc forms one connected graph,
   * and following it from `Skeleton` opened the whole `Curve` hierarchy and
   * more, each carrying walls in code no path executes. A read is what the
   * emitter actually needs a layout for, and a read inside a member only
   * counts once that member is live, so the closure stays bounded by what
   * runs.
   *
   * Opening the class's own statement is not scheduling its module's effects.
   * Layout-only declarations retain heritage and fields but do not run
   * constructors, initializers, or unrelated same-named method bodies. A real
   * value reference promotes the declaration and its module to normal runtime
   * reachability. Otherwise a default-exported alternative in a JSDoc union
   * can make a plain inherited-field read execute an entire unused subsystem.
   */
  const openClassOfReceiver = (access: ts.PropertyAccessExpression): void => {
    const type = input.checker.getTypeAtLocation(access.expression)
    const arms = type.isUnion() ? type.types : [type]
    for (const arm of arms) {
      if (((arm.symbol?.flags ?? 0) & ts.SymbolFlags.Class) === 0) continue
      for (const declaration of arm.symbol?.declarations ?? []) {
        if (!ts.isClassDeclaration(declaration)) continue
        const file = declaration.getSourceFile()
        if (!compiled.has(file) || !topLevelOf(file).has(declaration) || liveStatements.has(declaration)) continue
        openStatement(declaration, !liveFiles.has(file))
      }
    }
  }

  /**
   * Every class a TYPE names, opened for its LAYOUT alone.
   *
   * An annotation is erased, so it evaluates nothing and this walk rightly
   * refuses to run its module or its constructor. But erasure is not the only
   * thing that happens to it: the checker uses that same annotation to type a
   * live cell, and `representation/derive.ts` turns the result into a
   * `class-ref` carrier naming this declaration. So the class does have to be
   * projected, and layout-only is exactly the promotion that says so -- the
   * one `layoutClasses` already exists for, and the one a heritage clause on
   * an already-layout-only class already takes.
   *
   * Without this the two authorities disagree, and the disagreement is not
   * benign. A class the walk never opens publishes no class-lifecycle
   * operation, so `projection/classes.ts` has no row for it; `records.ts` then
   * renders its struct from the checker's FLATTENED shape with no base clause
   * (`classBaseLinks` reads the same empty row), and `hasClosedFixedLayout`
   * reports its storage unproven for want of a layout that was never missing
   * -- so the object gets the unrestricted field protocol over a struct that
   * repeats every inherited member. In the three.js app that is fourteen carriers, and
   * three of them (`Bone`, `Node`, `InstancedBufferAttribute`, each named only
   * inside a JSDoc annotation in a live file) were the program's three largest
   * reflection consumers.
   *
   * Over-marking is the safe direction here for the reason this module's
   * header already gives, and layout-only is the smallest promotion there is:
   * no module evaluation, no constructor, no member body.
   */
  const markTypeNamedClasses = (node: ts.Node): void => {
    const named = ts.isTypeReferenceNode(node) ? node.typeName : ts.isExpressionWithTypeArguments(node) ? node.expression : null
    if (named !== null) {
      const symbol = input.checker.getSymbolAtLocation(named)
      for (const declaration of symbol ? declarationsOf(input.checker, symbol) : []) {
        if (!ts.isClassDeclaration(declaration)) continue
        const file = declaration.getSourceFile()
        if (!compiled.has(file) || !topLevelOf(file).has(declaration) || liveStatements.has(declaration)) continue
        openStatement(declaration, !liveFiles.has(file))
      }
    }
    ts.forEachChild(node, markTypeNamedClasses)
  }

  /**
   * The same question for a JSDoc annotation, which `ts.forEachChild` does not
   * reach: JSDoc hangs off a node's comment ranges rather than its child list,
   * so a `@type`/`@param`/`@returns` type node is invisible to this walk while
   * being fully visible to the checker. Three.js types its whole public
   * surface this way, which is why every carrier in the state described above
   * is a class whose only mention in live code is inside a JSDoc comment.
   */
  const markJsDocNamedClasses = (node: ts.Node): void => {
    for (const tag of ts.getJSDocTags(node)) {
      if (ts.isJSDocAugmentsTag(tag) || ts.isJSDocImplementsTag(tag)) {
        markTypeNamedClasses(tag.class)
        continue
      }
      // Every tag whose payload is a type expression, narrowed by name because
      // `typeExpression` is declared per tag rather than on `JSDocTag` itself.
      const expression =
        ts.isJSDocTypeTag(tag) ||
        ts.isJSDocParameterTag(tag) ||
        ts.isJSDocReturnTag(tag) ||
        ts.isJSDocPropertyTag(tag) ||
        ts.isJSDocThisTag(tag) ||
        ts.isJSDocEnumTag(tag) ||
        ts.isJSDocSatisfiesTag(tag) ||
        ts.isJSDocTypedefTag(tag)
          ? tag.typeExpression
          : undefined
      if (expression !== undefined && ts.isJSDocTypeExpression(expression)) markTypeNamedClasses(expression.type)
    }
  }

  const markReferences = (node: ts.Node): void => {
    markJsDocNamedClasses(node)
    if (ts.isClassDeclaration(node) && layoutClasses.has(node)) {
      for (const heritage of node.heritageClauses ?? []) {
        if (heritage.token !== ts.SyntaxKind.ExtendsKeyword) continue
        for (const type of heritage.types) {
          const symbol = input.checker.getSymbolAtLocation(type.expression)
          const declarations = symbol ? declarationsOf(input.checker, symbol).filter(ts.isClassDeclaration) : []
          if (declarations.length === 0) markReferences(type.expression)
          else
            for (const declaration of declarations) {
              if (compiled.has(declaration.getSourceFile())) openStatement(declaration, !liveFiles.has(declaration.getSourceFile()))
            }
        }
      }
      for (const member of node.members) {
        if (ts.isConstructorDeclaration(member) || ts.isClassStaticBlockDeclaration(member)) continue
        if (ts.isPropertyDeclaration(member)) {
          if (ts.isComputedPropertyName(member.name)) markReferences(member.name)
          continue
        }
        if (memberIsDeferrable(member) && !liveMembers.has(member)) {
          // A type-only class is not a possible runtime override merely
          // because unrelated live code spells the same method name. Direct
          // member references still open its body through markSymbol. Runtime
          // promotion revisits the class and enables ordinary key dispatch.
          deferredMembers.add(member)
          continue
        }
        markReferences(member)
      }
      return
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return
    if (ts.isTypeNode(node)) {
      // `extends Base<T>` evaluates Base for a class; every other type node
      // is erased. Following an annotation through an import-type alias must
      // not schedule that module's top-level effects. Layout derivation still
      // reads all checker types independently of this runtime reachability walk.
      if (
        ts.isExpressionWithTypeArguments(node) &&
        ts.isHeritageClause(node.parent) &&
        node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
        (ts.isClassDeclaration(node.parent.parent) || ts.isClassExpression(node.parent.parent))
      )
        markReferences(node.expression)
      else markTypeNamedClasses(node)
      return
    }
    if (ts.isPropertyAccessExpression(node)) openClassOfReceiver(node)
    if (ts.isNewExpression(node)) {
      for (const signature of input.checker.getTypeAtLocation(node.expression).getConstructSignatures()) {
        const result = input.checker.getReturnTypeOfSignature(signature)
        for (const arm of result.isUnion() ? result.types : [result]) {
          if (((arm.symbol?.flags ?? 0) & ts.SymbolFlags.Class) !== 0) markSymbol(arm.symbol)
        }
      }
    }
    // `{ get }` NAMES `get`, and `getSymbolAtLocation` on that identifier
    // answers the PROPERTY it declares, not the value it reads -- the one
    // reference shape where the identifier's own symbol is the wrong end of
    // the edge. Without this, a function nothing else in the program calls was
    // pruned while a live module-scope object literal still read it, and
    // emission refused the read as "a declaration this program never
    // introduces": `http.ts`'s CommonJS-style default namespace naming its own
    // `get`.
    if (ts.isShorthandPropertyAssignment(node)) markSymbol(input.checker.getShorthandAssignmentValueSymbol(node))
    // A runtime key on a class constructor can select any declared static
    // member. There is no property-name symbol at `C[key]` for the walk to
    // follow, so keep the constructor type's finite static surface live. The
    // emitter later dispatches over this same set; pruning a method here would
    // leave a valid key out of that dispatch and turn `C[String('m')]()` into
    // an invocation of undefined. `getProperties()` includes inherited
    // statics, while the class-symbol/construct-signature guard keeps ordinary
    // object element accesses on the existing key-directed path.
    if (ts.isElementAccessExpression(node)) {
      const receiver = input.checker.getTypeAtLocation(node.expression)
      const arms = receiver.isUnion() ? receiver.types : [receiver]
      for (const arm of arms) {
        if ((arm.symbol?.flags ?? 0) & ts.SymbolFlags.Class && arm.getConstructSignatures().length > 0) {
          for (const property of arm.getProperties()) markSymbol(property)
        }
      }
    }
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      markReference(node)
      // EVERY identifier, not only one in member position, and measured that
      // way: narrowing this to `o.close` / `const { close } = o` and letting a
      // bare identifier spell nothing left the mongodb probe on the same 1635
      // unmet obligations, so precision bought nothing there while
      // over-marking costs only dead code left in. Under-marking is the one
      // direction that could drop a live body, which is why the walk stays
      // blunt about which names count -- exactly as this module's own header
      // says it is blunt about references.
      spellKey(node.text)
    }
    // `o['close']` is the same dispatch `o.close` is, wherever the string sits
    // -- `Reflect.get(o, 'close')`, a key held in a `const`. A TEMPLATE with
    // substitutions spells nothing, and neither does a computed key, which is
    // sound here for the reason `ir/shake.ts`'s own `MemberReach` states: this
    // backend can address a method or accessor only through a key spelled at
    // compile time.
    if (ts.isStringLiteralLike(node)) spellKey(node.text)
    // A method's body is held back until something names it, exactly as a
    // top-level function declaration's is. Its own name and its parameter list
    // still walk -- the signature is part of the class's shape, and a
    // parameter's default runs at call time -- so only the body waits.
    if (memberIsDeferrable(node)) {
      deferredMembers.add(node)
      if (!memberIsStatic(node) && !liveMembers.has(node)) {
        const key = memberKeyOf(node)
        // Opened straight into `liveMembers` rather than through `openMember`:
        // this node is being walked right now, and queueing it as well would
        // walk the same body twice. A member with no readable key is kept.
        if (key === null || spelledKeys.has(key)) liveMembers.add(node)
        else pendingByKey.set(key, [...(pendingByKey.get(key) ?? []), node])
      }
      if (!liveMembers.has(node)) {
        for (const parameter of node.parameters) markReferences(parameter)
        return
      }
    }
    ts.forEachChild(node, markReferences)
  }

  const openMember = (member: ts.Node): void => {
    if (liveMembers.has(member)) return
    liveMembers.add(member)
    // Walked now if the class was already opened, and by `markReferences` when
    // it is -- either order reaches the body exactly once.
    if (deferredMembers.has(member)) memberQueue.push(member)
  }

  while (fileQueue.length > 0 || statementQueue.length > 0 || memberQueue.length > 0) {
    const file = fileQueue.pop()
    if (file) {
      openFile(file)
      continue
    }
    const member = memberQueue.pop()
    if (member) {
      ts.forEachChild(member, markReferences)
      continue
    }
    const statement = statementQueue.pop()
    if (statement) markReferences(statement)
  }

  // A layout-only class publishes no `bind-class-value` constructor object and
  // therefore no binding for its own NAME (`producers/class-lifecycle.ts`), so
  // a program that reads that name as a value -- `v instanceof C`, `const K =
  // C` -- refuses at emission with nothing but a declaration id to go on. The
  // list is one line per class and is only ever wanted while tracking such a
  // refusal down, so it is an instrument like `GEA_SHAKE_DEBUG`, not a result.
  if (process.env['GEA_REACH_DEBUG'])
    for (const node of layoutClasses) {
      const file = node.getSourceFile()
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
      console.log(`[REACH] layout-only class ${node.name?.text ?? '<anonymous>'} ${file.fileName}:${line + 1}`)
    }

  // The same question per FILE, for the case the list above answers `no` to:
  // a class that is neither live nor layout-only was never opened at all, and
  // the difference between "opened for its layout" and "never reached" is the
  // difference between a class with a projected row and one the checker types
  // while no census ever saw it. Keyed by a file-name substring because the
  // answer is only ever wanted about one file.
  const fileWatch = process.env['GEA_REACH_WATCH']
  if (fileWatch)
    for (const file of input.files) {
      if (!file.fileName.includes(fileWatch)) continue
      console.log(`[REACH] file ${file.fileName} live=${liveFiles.has(file)}`)
      for (const statement of file.statements) {
        if (!ts.isClassDeclaration(statement)) continue
        const { line } = file.getLineAndCharacterOfPosition(statement.getStart(file))
        const state = layoutClasses.has(statement) ? 'layout-only' : liveStatements.has(statement) ? 'live' : 'unreached'
        console.log(`[REACH]   class ${statement.name?.text ?? '<anonymous>'}:${line + 1} ${state}`)
      }
    }

  const reached = new Map<ts.SourceFile, readonly ts.Statement[]>()
  return {
    classIsLayoutOnly: (node) => layoutClasses.has(node),
    memberIsPruned: (node) => {
      if (deferredMembers.has(node) && !liveMembers.has(node)) return true
      const parent = node.parent
      if (!parent) return false
      if (ts.isHeritageClause(node) && ts.isClassDeclaration(parent) && layoutClasses.has(parent)) return true
      if ((ts.isConstructorDeclaration(node) || ts.isClassStaticBlockDeclaration(node)) && ts.isClassDeclaration(parent))
        return layoutClasses.has(parent)
      return (
        ts.isPropertyDeclaration(parent) &&
        parent.initializer === node &&
        ts.isClassDeclaration(parent.parent) &&
        layoutClasses.has(parent.parent)
      )
    },
    statementsOf: (file) => {
      const known = reached.get(file)
      if (known) return known
      const built = file.statements.filter((statement) => liveStatements.has(statement))
      reached.set(file, built)
      return built
    }
  }
}
