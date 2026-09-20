import ts from 'typescript'
import { declarationId, functionId, nodeId, type DeclarationId, type FunctionId, type NodeId } from '../../identity/ids.js'
import { isAmbientDeclaration } from '../ambient.js'
import { emptySpecializationCensus, genericSubjectOf, type SpecializationCensus } from './specialization.js'
import { createPathSubstitution } from './structural-generics.js'

/**
 * Minting identities from checker facts.
 *
 * Identity here is *structural position*, never a byte offset and never a file
 * path. A file is identified by its index in the program's sorted root list, and
 * a node by the ordinal it receives in a deterministic pre-order walk of that
 * file. Both are stable under reformatting, renaming a local, and moving a file
 * on disk -- which is exactly the property an offset does not have.
 *
 * Relative order is retained because JavaScript semantics depend on it:
 * declaration order, evaluation order, and hoisting are real behavior. What is
 * excluded is using a *particular* position as evidence that a particular
 * program is being compiled.
 */

/**
 * One link in the chain of monomorphized copies a node is being compiled
 * inside: which generic was instantiated, and which of its instantiations this
 * is.
 *
 * The owner travels with the ordinal because resolving a type parameter needs
 * both. An ordinal alone says "the first instantiation" without saying of what,
 * and a node inside two nested generics has two ordinals that mean nothing until
 * each is paired with the generic it indexes.
 */
export interface SpecializationStep {
  readonly owner: ts.Declaration
  readonly ordinal: number
}

/**
 * Which monomorphized copy an identity belongs to, outermost first.
 *
 * The empty path is a body that is not inside any generic, which is every body
 * in a program that declares none -- and its identities stay byte-identical to
 * what they were before monomorphization, because an empty path adds no suffix.
 */
export type SpecializationPath = readonly SpecializationStep[]

export const rootSpecialization: SpecializationPath = []

/**
 * The identity suffix for a path: the ordinals alone.
 *
 * The owner is deliberately left out. A node's own identity already pins where
 * it is, so which generics enclose it is not in question -- only which copy is,
 * and that is what the ordinals say. Putting the owner in as well would make the
 * suffix longer without making any two copies more distinguishable.
 */
export const specializationKey = (path: SpecializationPath): string => path.map((step) => step.ordinal).join('.')

export interface IdentityTable {
  /**
   * The same table, minting identities for one monomorphized copy.
   *
   * A view rather than an argument on every method, for the same reason the
   * structural mapper has one: producers ask these questions from a hundred
   * places, and threading the copy through all of them would express, a hundred
   * times, one fact that belongs to the candidate being compiled.
   *
   * The view does NOT stamp the path onto every identity it mints. A body
   * inside a copy routinely names things outside it -- a module-scope constant,
   * an imported class -- and stamping those would mint a second identity for
   * one declaration, which is exactly the two-identities-for-one-thing defect
   * identities exist to prevent. What it stamps is the longest prefix of the
   * path whose generics actually contain the node, which is empty for anything
   * declared outside them.
   */
  readonly forSpecialization: (path: SpecializationPath) => IdentityTable
  /**
   * What distinguishes one monomorphized copy from another *as a copy*, owner
   * included.
   *
   * Deliberately not `specializationKey`, and the difference is load-bearing.
   * That one is an identity *suffix*, where the owner is redundant because a
   * node's own identity already says which generic encloses it. Here the owner
   * is the entire question: two unrelated generics each instantiated once both
   * have ordinal path `0`, so anything caching per copy under that key hands
   * the second generic the first one's answers -- including `prefixFor`'s
   * answer to "is this node inside a copy", which is `false` for every node of
   * the generic the cached view was not built for. Every identity minted
   * through such a view comes out unspecialized, so a body and the allocation
   * that gives it a calling convention end up naming different copies.
   */
  readonly copyKeyOf: (path: SpecializationPath) => string
  /**
   * How much of a copy's path applies to one node: the longest prefix whose
   * generics lexically contain it, empty for anything declared outside them.
   *
   * Exposed because composing a path is not something a caller may invent. A
   * use site inside one copy that names a generic declared *elsewhere* reaches
   * a copy of that other generic, and appending its step to this walk's whole
   * path would mint `decl|X@0.0` -- an id no census walk ever publishes, since
   * the census walks that generic from the scope it was declared in. The
   * composed path is this prefix plus the site's own step, and this is the one
   * function that says what the prefix is.
   */
  readonly prefixFor: (node: ts.Node, path: SpecializationPath) => SpecializationPath
  /**
   * The identity segment every declaration in one file is minted under.
   *
   * Exposed so the frontend can publish which file each identity's segment
   * names (`FrontendResult.sourceFileNames`) without any later stage learning
   * the rule this table uses to spell it.
   */
  readonly fileIdentityOf: (file: ts.SourceFile) => string
  /**
   * Every file the program holds, identity segment to file name. This is the
   * whole program -- library and ambient files included -- because a unit can
   * be owned by any file an identity was minted under, not only the compiled
   * sources. Display evidence for naming emitted units; nothing decides on it.
   */
  readonly sourceFileNames: ReadonlyMap<string, string>
  readonly nodeIdOf: (node: ts.Node, path?: SpecializationPath) => NodeId
  readonly declarationIdOf: (declaration: ts.Declaration, path?: SpecializationPath) => DeclarationId
  readonly functionIdOf: (declaration: ts.Declaration, path?: SpecializationPath) => FunctionId
  /**
   * The declaration a symbol is *anchored* on: the one the structural walk
   * interns a shape under, and the one a nominal type is identified by.
   *
   * This is not always the declaration that supplies a value -- see
   * `valueDeclarationOfSymbol`, which answers the other question. Keeping them
   * apart is load-bearing rather than tidy: a merged ambient global is one
   * symbol with a type-space declaration and a value-space one, and the two
   * questions genuinely have different answers for it.
   */
  readonly declarationOfSymbol: (symbol: ts.Symbol) => ts.Declaration | null
  /**
   * The declaration that supplies a symbol's *value*, or `null` when it has
   * none.
   *
   * A merged ambient global -- `interface Error {}` for the type plus
   * `declare var Error: ErrorConstructor` for the value -- is one symbol with
   * two declarations, and only the second one holds anything. Asking the
   * anchor question instead returns the interface whenever it sorts first
   * (true for `Error`, `Math`, `Date`, `JSON` and every other merged global in
   * lib.es5.d.ts), which mints a binding read against a declaration nothing
   * ever introduces -- the emitter then refuses the read by name, after
   * preflight has already certified the program.
   *
   * `frontend.ts`'s `bindAmbientValue` resolves the host placement this exact
   * way, so a read minted here and the placement it must find are keyed by one
   * rule rather than two.
   */
  readonly valueDeclarationOfSymbol: (symbol: ts.Symbol) => ts.Declaration | null
  /**
   * The declaration whose type parameters a node's value writes down -- the
   * node monomorphized copies are keyed on.
   *
   * `specialization.ts` owns the rule; this is where the checker gets bound
   * into it, because one of its cases -- `const jsxs = jsx`, a generic named as
   * a value -- needs a name resolved to what it denotes. Every consumer has to
   * ask through here, or the census forks one node and the reads name another.
   */
  readonly genericSubjectOf: (declaration: ts.Declaration) => ts.Declaration
  /**
   * Identity of the symbol a name resolves to, following aliases to their
   * target.
   *
   * `at` is the node doing the naming, and it matters for exactly one reason:
   * a name that reaches a generic reaches one of its monomorphized copies, and
   * which one is decided by the instantiation the *use site* makes, not by
   * anything about the declaration. `identity(1)` and `identity('one')` name
   * two different functions through one symbol.
   */
  readonly symbolDeclarationId: (symbol: ts.Symbol, at?: ts.Node) => DeclarationId | null
  /**
   * Identity of the declaration a name's *value* comes from -- the same
   * question `symbolDeclarationId` asks, resolved through
   * `valueDeclarationOfSymbol` instead of the anchor.
   */
  readonly symbolValueDeclarationId: (symbol: ts.Symbol, at?: ts.Node) => DeclarationId | null
}

/**
 * A node's attached JSDoc, which the shipped declarations mark `@internal`.
 *
 * Named structurally rather than reached through `any`: the parser writes this
 * list, `ts.forEachChild` does not report it, and `ts.getJSDocTags` reports only
 * part of it (see `walkOrdinals`).
 */
interface JsDocCarrier {
  readonly jsDoc?: readonly ts.JSDoc[]
}

/**
 * Ordinals for every node of a file, in one deterministic order.
 *
 * Two passes, and the second one is not an afterthought: `ts.forEachChild` does
 * not descend into a node's attached JSDoc, and in a JavaScript source **JSDoc
 * is the type syntax**. `/** @type {{start:number,count:number}} *\/` parses to a
 * real `TypeLiteral` -- the declaration of an anonymous object type, exactly
 * what `const x: { start: number }` declares in TypeScript -- and the checker
 * hands that node back as a declaration like any other. Reached only through
 * `node.jsDoc`, it never entered the map, so `declarationIdOf` threw and every
 * producer that touched the type reported a failure instead of a type. That was
 * 3291 of the three.js app's 6492 diagnostics: three.js is compiled from source, so its
 * JSDoc is load-bearing.
 *
 * The JSDoc pass runs *after* the whole child walk rather than inline with it,
 * so every ordinal a program already had keeps the value it had: JSDoc
 * identities are appended past the end, and nothing that did not need this
 * moves. Determinism is unaffected -- the second pass repeats the first pass's
 * order and visits each node's tags in source order.
 */
const walkOrdinals = (file: ts.SourceFile): Map<ts.Node, number> => {
  const ordinals = new Map<ts.Node, number>()
  let next = 0
  const assign = (node: ts.Node): void => {
    if (ordinals.has(node)) return
    ordinals.set(node, next)
    next += 1
  }
  const visit = (node: ts.Node): void => {
    assign(node)
    ts.forEachChild(node, visit)
  }
  visit(file)

  // The attached comments themselves, which `forEachChild` skips and no public
  // accessor reports in full: `ts.getJSDocTags` was tried first and drops whole
  // blocks -- a host carrying three comments, one of them a `@callback`, hands
  // back only the tags of the other two, so every `JSDocSignature` in
  // `three/src/loaders/Loader.js` stayed unreachable. `node.jsDoc` is the
  // parser's own list and is complete; it is `@internal` in the shipped
  // declarations, so the field is named here in a structural type rather than
  // reached through `any`. `forEachChild` DOES descend once inside a JSDoc node,
  // so one walk from each comment reaches every tag, type expression and
  // literal under it.
  const visitJsDoc = (node: ts.Node): void => {
    for (const comment of (node as ts.Node & JsDocCarrier).jsDoc ?? []) visit(comment)
    ts.forEachChild(node, visitJsDoc)
  }
  visitJsDoc(file)
  return ordinals
}

export const createIdentityTable = (
  program: ts.Program,
  checker: ts.TypeChecker,
  specializations: SpecializationCensus = emptySpecializationCensus
): IdentityTable => {
  // Sorting by the program's own file names gives a deterministic index without
  // that name ever reaching an identity: only the index does.
  //
  // Ambient declaration files are indexed too. They are not compiled, but every
  // program references declarations that live in them -- `Array`, `Promise`,
  // `Record` -- and a declaration the compiler can reach must have an identity
  // wherever it was declared. Excluding them makes `declarationIdOf` throw the
  // first time any real program mentions a library type.
  const files = program
    .getSourceFiles()
    .slice()
    .sort((left, right) => (left.fileName < right.fileName ? -1 : left.fileName > right.fileName ? 1 : 0))
  const fileIndex = new Map<ts.SourceFile, string>()
  files.forEach((file, index) => fileIndex.set(file, `f${index}`))

  const ordinalsByFile = new Map<ts.SourceFile, Map<ts.Node, number>>()
  const ordinalOf = (node: ts.Node): { file: string; ordinal: number } => {
    const file = node.getSourceFile()
    const identity = fileIndex.get(file)
    if (identity === undefined) throw new Error('node belongs to a source file outside the compiled program')
    let ordinals = ordinalsByFile.get(file)
    if (!ordinals) {
      ordinals = walkOrdinals(file)
      ordinalsByFile.set(file, ordinals)
    }
    const ordinal = ordinals.get(node)
    if (ordinal === undefined) throw new Error('node was not reached by the deterministic walk of its source file')
    return { file: identity, ordinal }
  }

  const fileIdentityOf = (file: ts.SourceFile): string => {
    const identity = fileIndex.get(file)
    if (identity === undefined) throw new Error('source file is outside the compiled program')
    return identity
  }
  const sourceFileNames: ReadonlyMap<string, string> = new Map(files.map((file) => [fileIdentityOf(file), file.fileName]))

  const nodeIdOf = (node: ts.Node, path: SpecializationPath = rootSpecialization): NodeId => {
    const { file, ordinal } = ordinalOf(node)
    const id = nodeId(file, ts.SyntaxKind[node.kind], ordinal, specializationKey(path))
    return id
  }

  const declarationIdOf = (declaration: ts.Declaration, path: SpecializationPath = rootSpecialization): DeclarationId => {
    const { file, ordinal } = ordinalOf(declaration)
    const id = declarationId(file, ordinal, specializationKey(path))
    return id
  }

  const functionIdOf = (declaration: ts.Declaration, path: SpecializationPath = rootSpecialization): FunctionId =>
    functionId(declarationIdOf(declaration, path))

  /**
   * The symbol a reference denotes once import aliases are followed.
   *
   * `import { f } from './m'` and a direct reference to `f` are the same
   * binding, and treating them as two would let one operation acquire two
   * identities. Checked JavaScript's `const f = require('./m')` is ALSO an
   * alias to the checker -- that is how it types `f.x` from the target's
   * `module.exports` -- but at run time it is a local cell the loader's
   * result is stored into, and its declaration is the variable, not the
   * target module's `module.exports = ...` assignment. Following it named a
   * declaration the program never introduces (`native-boundary:external-
   * binding` on fastify's `const AjvCompiler = require(...)`). An alias whose
   * own declaration is a variable or a binding element is that cell.
   */
  const aliasTargetOf = (symbol: ts.Symbol): ts.Symbol => {
    if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol
    if ((symbol.declarations ?? []).some((declaration) => ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)))
      return symbol
    return checker.getAliasedSymbol(symbol)
  }

  const declarationOfSymbol = (symbol: ts.Symbol): ts.Declaration | null => {
    const resolved = aliasTargetOf(symbol)
    // A merged ambient global -- `interface Error {}` for the type plus
    // `declare var Error: ErrorConstructor` for the value -- is one symbol with
    // two declarations, and this returns the first. For a *value* reference
    // that is the wrong one whenever the interface sorts earlier: the name then
    // anchors on a type-space declaration that has no constructor, which is why
    // `new Error(...)` finds no callable.
    //
    // Preferring `valueDeclaration` here is NOT the fix, and it was measured:
    // both the unconditional form and one narrowed to the interface-first merge
    // sent a whole family of corpus programs into unbounded recursion.
    // The reason is that this one function answers two questions. The same
    // declaration is the nominal ANCHOR the structural walk interns a shape
    // under, and moving `Error`'s anchor onto its `var` makes that anchor's type
    // `ErrorConstructor`, whose `prototype: Error` closes the cycle the anchor
    // existed to break.
    //
    // So the value declaration belongs to the caller that is resolving a value,
    // not to this shared resolution. Splitting the two is the fix, and it is not
    // a one-line one.
    const declarations = resolved.getDeclarations()
    return declarations && declarations.length > 0 ? (declarations[0] ?? null) : null
  }

  /**
   * The value half of the question `declarationOfSymbol` answers.
   *
   * The body of an overloaded function creates its one runtime binding;
   * otherwise `valueDeclaration` is TypeScript's answer to which declaration
   * holds the value. The fallback matters: a symbol with no
   * value declaration at all -- a pure type -- keeps the anchor's answer, which
   * is what every caller that is *not* resolving a value already relies on.
   */
  const valueDeclarationOfSymbol = (symbol: ts.Symbol): ts.Declaration | null => {
    const resolved = aliasTargetOf(symbol)
    // Overload signatures introduce no function object. TypeScript's value
    // declaration can be the first signature, but every read must name the
    // implementation binding that FunctionDeclarationInstantiation creates.
    const implementation = resolved
      .getDeclarations()
      ?.find((declaration) => ts.isFunctionDeclaration(declaration) && declaration.body !== undefined)
    if (implementation) return implementation
    return resolved.valueDeclaration ?? declarationOfSymbol(resolved)
  }

  /**
   * `genericSubjectOf` with the checker bound in, and memoized.
   *
   * Memoized because `prefixFor` asks it once per step per node -- the hottest
   * path in the whole table -- and the identifier case costs a symbol
   * resolution. The answer is a pure function of the node, so caching it is
   * caching a fact rather than a decision.
   */
  const subjects = new Map<ts.Declaration, ts.Declaration>()
  const targetOfName = (name: ts.Identifier): ts.Declaration | null => {
    const symbol = checker.getSymbolAtLocation(name)
    return symbol ? valueDeclarationOfSymbol(symbol) : null
  }
  const subjectOf = (declaration: ts.Declaration): ts.Declaration => {
    const known = subjects.get(declaration)
    if (known !== undefined) return known
    const subject = genericSubjectOf(declaration, targetOfName)
    subjects.set(declaration, subject)
    return subject
  }

  /**
   * Which copy a use site reaches, when the thing it names is a generic this
   * program instantiates.
   *
   * The site recorded by the specialization census is the call or the type
   * reference itself, so a name in callee position asks about its parent. A
   * name that reaches no instantiation answers `null` and falls back to the
   * lexical rule, which is what every non-generic reference wants.
   *
   * `substitute` is what the copy doing the naming binds a type parameter to. A
   * site inside a generic is routinely written with that generic's own
   * parameter -- `extends Component<Root>` -- and its arguments are concrete
   * only once they have been substituted for this copy. Without it such a site
   * reads as "no instantiation" and the name falls back to the unspecialized
   * declaration, which is a class the census never published.
   */
  const useSitePath = (
    declaration: ts.Declaration,
    at: ts.Node | undefined,
    substitute?: (type: ts.Type) => ts.Type
  ): SpecializationPath | null => {
    // The node the census keys copies on, which for `const f = <T>...` is the
    // arrow rather than the declaration naming it -- see `genericSubjectOf`.
    // Both the comparison and the path entry use it, so a name resolves to the
    // very entry `census.ts` pushed when it forked.
    const subject = subjectOf(declaration)
    for (const node of [at, at?.parent]) {
      const site = node ? specializations.specializationAt(node, substitute) : null
      if (site && site.declaration === subject) return [{ owner: subject, ordinal: site.ordinal }]
    }
    // No site, and a `const f = <T>...` with exactly ONE copy: that copy is the
    // only thing the name can mean. The root identity is not an alternative --
    // `census.ts` records this declaration per copy and never at the root, so
    // falling back to it names a declaration the program does not introduce,
    // which the emitter then refuses by name at the read.
    //
    // This is `instantiation.ts`'s own rule one level up: a hole filled the
    // same way everywhere has one answer, and taking it is exact rather than
    // an approximation. Two or more copies has no single answer -- `const jsxs
    // = jsx` genuinely denotes a template, which C++ has no value for -- and
    // falls through to be refused rather than answered with a guess.
    //
    // ⛔ NARROW ON PURPOSE -- but the line is AMBIENT, not the spelling.
    //
    // The first cut of this rule was `if (subject === declaration) return
    // null`, which admitted only the `const f = <T>...` spelling, where the
    // subject is the arrow and the declaration the variable naming it.
    // Applied to every generic instead, it re-keyed names that were resolving
    // to the root correctly and had every right to: measured over the corpus,
    // `image-demo` lost its certificate to a `return-conversion:
    // native-handle(GeaEmbeddedImage) -> native-record-ref` that did not
    // exist before, `e-reader` stopped emitting on a `SetConstructor` handle
    // that "carries no [[Construct]] convention", and `dialer` stopped
    // compiling.
    //
    // Every one of those is a declaration a HOST owns: `Set`, `Map`,
    // `GeaEmbeddedImage`. A host's protocol is keyed on the root, because the
    // host implements the thing once and this program never forks it, so
    // answering a copy for one breaks the binding rather than fixing one.
    // That is the real line, and `semantics/ambient.ts` already draws it --
    // "declared, never defined" is exactly "the root is the only id there
    // is".
    //
    // A generic this program DEFINES is the other side: `census.ts` records
    // it per copy and never at the root, so a name that falls back to the
    // root names a declaration the program does not introduce, which the
    // emitter then refuses by name at the read. hono reaches this with
    // `new HonoRequest(...)` (introduced as `decl|f77|148@0`, read as
    // `decl|f77|148`) and with a plain generic function declaration called
    // from one of its own copies.
    if (isAmbientDeclaration(declaration)) return null
    const copies = specializations.specializationsOf(subject)
    const only = copies.length === 1 ? copies[0] : undefined
    if (only) return [{ owner: subject, ordinal: only.ordinal }]
    return null
  }

  const symbolDeclarationId = (symbol: ts.Symbol, at?: ts.Node): DeclarationId | null => {
    const declaration = declarationOfSymbol(symbol)
    if (!declaration) return null
    return declarationIdOf(declaration, useSitePath(declaration, at) ?? rootSpecialization)
  }

  const symbolValueDeclarationId = (symbol: ts.Symbol, at?: ts.Node): DeclarationId | null => {
    const declaration = valueDeclarationOfSymbol(symbol)
    if (!declaration) return null
    return declarationIdOf(declaration, useSitePath(declaration, at) ?? rootSpecialization)
  }

  /**
   * How much of a copy's path applies to one node.
   *
   * A node is inside a generic when that generic is one of its ancestors. The
   * path lists the copies enclosing the *candidate*, outermost first, so the
   * answer for any other node is the longest prefix of that list whose owners
   * are all ancestors of it -- full path for a node in the copy's own body,
   * empty for one declared outside every enclosing generic, and a proper prefix
   * for one in an outer generic but not an inner.
   */
  const contains = (ancestor: ts.Node, node: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) if (current === ancestor) return true
    return false
  }
  /**
   * Whether one copy's step applies to this node.
   *
   * Ancestry is the usual answer: a node inside a generic's body belongs to
   * whichever copy of it is being walked. `const f = <T>(x: T) => x` is the one
   * shape where the relation runs the other way -- the copy is keyed on the
   * arrow, which is the declaration's CHILD, so ancestry says no for the
   * declaration that names it while `census.ts` has already recorded that
   * declaration under the copy's path. Two answers for one node, and the read
   * then names an identity the program never introduces.
   */
  /**
   * Whether `node` sits in a variable declaration whose subject is this step's
   * owner.
   *
   * `census.ts` walks a forked declaration's WHOLE subtree under the copy's
   * path -- the name, the type annotation, and for `const jsxs = jsx` the
   * initializer that names the subject. Agreeing only about the declaration
   * node itself leaves every node under it minted at the root while the census
   * recorded it in the copy, which is a dangling citation for any of them that
   * produces a cited result: the alias's own initializer read is exactly that,
   * and it withheld the declaration that cites it.
   *
   * The first enclosing variable declaration is the answer, not the first
   * MATCHING one. A node inside a nested declaration belongs to that one; if it
   * also belongs to this copy it is reached by ancestry below, which is the
   * ordinary rule.
   */
  const inDeclarationOf = (owner: ts.Node, node: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
      if (ts.isVariableDeclaration(current)) return subjectOf(current) === owner
      if (ts.isSourceFile(current)) return false
    }
    return false
  }
  const stepApplies = (owner: ts.Node, node: ts.Node): boolean => inDeclarationOf(owner, node) || contains(owner, node)
  const prefixFor = (node: ts.Node, path: SpecializationPath): SpecializationPath => {
    let length = 0
    while (length < path.length) {
      const step = path[length]
      if (!step || !stepApplies(step.owner, node)) break
      length += 1
    }
    return length === path.length ? path : path.slice(0, length)
  }

  const copyKeyOf = (path: SpecializationPath): string => path.map((step) => `${nodeIdOf(step.owner)}#${step.ordinal}`).join('/')

  const views = new Map<string, IdentityTable>()
  const forSpecialization = (path: SpecializationPath): IdentityTable => {
    const key = copyKeyOf(path)
    const cached = views.get(key)
    if (cached) return cached
    // What this copy binds each type parameter to, which is what turns a site
    // written with an enclosing generic's own parameter (`extends
    // Component<Root>`) into the concrete arguments that name one copy. Built
    // once per view, for the same reason the view itself exists.
    const substituteInPath = createPathSubstitution(declarationOfSymbol, specializations, path)
    // An INLINE generic callable -- `memoizeOne(<T extends JSDocType>(kind) =>
    // ...)` -- is its own copy's subject, and the census records its
    // allocation under that copy (`census.ts` forks at the arrow) while the
    // call holding it asks from the enclosing path. The site the census keyed
    // on the arrow itself (`specialization.ts`'s `fromValueUse`) names the
    // copy, exactly as `useSitePath` resolves a NAME to one; without it the
    // caller cited an allocation minted under a path it never spelled.
    const pathOf = (node: ts.Node): SpecializationPath => {
      const prefix = prefixFor(node, path)
      if (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return prefix
      if (prefix.some((step) => step.owner === node)) return prefix
      const site = specializations.specializationAt(node, substituteInPath)
      return site && site.declaration === node ? [...prefix, { owner: node, ordinal: site.ordinal }] : prefix
    }
    const view: IdentityTable = {
      forSpecialization,
      copyKeyOf,
      prefixFor,
      fileIdentityOf,
      sourceFileNames,
      nodeIdOf: (node, override) => nodeIdOf(node, override ?? pathOf(node)),
      declarationIdOf: (declaration, override) => declarationIdOf(declaration, override ?? pathOf(declaration)),
      functionIdOf: (declaration, override) => functionIdOf(declaration, override ?? pathOf(declaration)),
      declarationOfSymbol,
      valueDeclarationOfSymbol,
      genericSubjectOf: subjectOf,
      symbolDeclarationId: (symbol, at) => {
        const declaration = declarationOfSymbol(symbol)
        if (!declaration) return null
        return declarationIdOf(declaration, useSitePath(declaration, at, substituteInPath) ?? prefixFor(declaration, path))
      },
      symbolValueDeclarationId: (symbol, at) => {
        const declaration = valueDeclarationOfSymbol(symbol)
        if (!declaration) return null
        return declarationIdOf(declaration, useSitePath(declaration, at, substituteInPath) ?? prefixFor(declaration, path))
      }
    }
    views.set(key, view)
    return view
  }

  return {
    forSpecialization,
    copyKeyOf,
    prefixFor,
    fileIdentityOf,
    sourceFileNames,
    nodeIdOf,
    declarationIdOf,
    functionIdOf,
    declarationOfSymbol,
    valueDeclarationOfSymbol,
    genericSubjectOf: subjectOf,
    symbolDeclarationId,
    symbolValueDeclarationId
  }
}
