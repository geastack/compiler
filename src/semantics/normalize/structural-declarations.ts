import ts from 'typescript'
import type { DeclarationId } from '../../identity/ids.js'
import type { StructuralAccessor } from '../model/structural-types.js'
import { censusedTypeAt, isStandardInterfaceType } from './derived-expression-type.js'
import { emptyParameterBindingCensus, type ParameterBindingCensus } from './parameter-bindings.js'
import { forEachReachableStatement, type ProgramReachability } from './reachability.js'

/**
 * The type of the value a declaration binds, asked of the declaration's own
 * name rather than of the declaration node.
 *
 * The two differ, and the difference is the point: a node's type at its own
 * position can be the *declared* type of the thing being defined, while the
 * symbol its name introduces carries what a reader of that name receives. For
 * a method those coincide; for anything whose name is introduced by a
 * declaration the checker treats specially they do not, and the name is the
 * authority on what the binding holds. A class is the motivating case: the
 * checker's own type AT a class declaration node is its *instance* type, and
 * only asking after the class's own name symbol recovers the constructor.
 *
 * A function expression or arrow function is excluded from that: for both,
 * `ts.getNameOfDeclaration` never reads the node's own name (a *named*
 * function expression's name included) and instead always defers to
 * `getAssignedName`, which walks up to whatever the value is being stored
 * into -- a variable declarator, a property assignment, a binding element --
 * and answers with THAT construct's own declared type. For
 * `activeRecorder.ondataavailable = (event) => {}` this resolves to the
 * property's declared `Handler | null`, not the arrow's own
 * `(event: Event) => void`. Handing that union back as a *callable
 * allocation's* own shape is the same defect `accessorSignatureOf`'s doc
 * comment already names for accessors ("reading the property's type there
 * hands the callable carrier a scalar"): one call to
 * `OrdinaryFunctionCreate`/`InstantiateArrowFunctionExpression` allocates a
 * plain callable independent of wherever it is later stored, and an optional
 * or nullable wrapper is a fact about that later BINDING, never about this
 * value -- so it must not reach `allocations.ts`'s `shape` field for the
 * allocation itself. A method or a plain function declaration never takes
 * this path: `getNameOfDeclaration` reads their OWN name directly, so no
 * assignment target's type can substitute for theirs.
 *
 * `null` when the declaration introduces no name the checker resolves to a
 * symbol, which is the caller's cue to fall back to the node's own type --
 * exactly what a function expression or arrow function now always does.
 */
export const declaredValueTypeOf = (checker: ts.TypeChecker, node: ts.Declaration): ts.Type | null => {
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return null
  const name = ts.getNameOfDeclaration(node)
  const symbol = name ? checker.getSymbolAtLocation(name) : undefined
  // STATED, not held: this function's whole job (see the header comment) is
  // reading what the BINDING's own name was ANNOTATED/declared as, precisely
  // so callers can compare it against what the initializer physically is
  // (`physicalInitializerTypeOf`, below). A census answers "what does this
  // node hold"; asking it here would substitute the held value for the
  // declared one this function exists to name, collapsing the very
  // distinction its callers depend on.
  return symbol ? checker.getTypeOfSymbolAtLocation(symbol, node) : null
}

/**
 * The type of the FUNCTION LITERAL a declaration is initialized with, when the
 * declaration's own annotation is an overload set and the literal is not.
 *
 * `class Context { json: JSONRespond = (object, arg?, headers?) => {...} }`
 * (hono's `context.ts`) is the shape. `JSONRespond` declares two call
 * signatures differing at a shared parameter -- `status?: U` in one,
 * `init?: ResponseOrInit<U>` in the other -- so `sharedAbiOf` (derive.ts)
 * rightly finds no single convention and `widestSubsumingAbi` (host-abi.ts)
 * rightly declines to widen, since that only forgives a TRAILING-optional
 * difference and not a differing type at a shared position. The member then
 * carries `unresolved(no primitive joining 2 overload signatures into one
 * calling convention)`.
 *
 * But nothing with two conventions is ever allocated here. A function or arrow
 * LITERAL cannot itself be overloaded -- only a `function` declaration merges
 * that way -- so the checker types this initializer as exactly one signature,
 * whose second parameter is the union `U | ResponseOrInit<U>` the body already
 * discriminates on at runtime (`typeof arg === 'number' ? ...`). One physical
 * convention, which this backend does model.
 *
 * This is `declaredValueTypeOf`'s own rule one level out. That function already
 * refuses to let a storage slot's declared type reach a callable ALLOCATION's
 * shape, for the reason its comment gives: the allocation is independent of
 * wherever the value is later stored. The same is true of a member whose
 * initializer is that allocation -- so the member's physical type is the
 * literal's, not the annotation's.
 *
 * Sound because the checker has already proved the literal assignable to every
 * declared overload; that is what let the program typecheck at all. This reads
 * back the concrete answer the checker computed for the literal rather than
 * inventing one. `null` whenever either half of the premise fails -- no
 * function-literal initializer, or a declared type that was never an overload
 * set -- so nothing that already resolves is re-derived.
 */
/**
 * The single physical type of a node that DECLARES a binding annotated with an
 * overloaded type, or `null` when the node is not one.
 *
 * `physicalInitializerTypeOf` asks this of a declaration whose type is already
 * in hand; this is the same question asked of a bare node, which is what
 * `structural.ts`'s `typeAt` has -- the BINDING's own type, as opposed to the
 * ALLOCATION's, which `valueTypeAt` answers from the initializer directly. Both
 * have to agree: hono's `export const parseBody: ParseBody = async (...)`
 * allocated one async arrow and bound it under `ParseBody`'s two overloads, so
 * the value had one convention and the name it is read through had none.
 */
export const physicalOverloadTypeAt = (
  checker: ts.TypeChecker,
  node: ts.Node,
  parameters: ParameterBindingCensus = emptyParameterBindingCensus
): ts.Type | null => {
  const declaration = node as ts.Declaration
  const declares =
    ts.isVariableDeclaration(declaration) ||
    ts.isPropertyDeclaration(declaration) ||
    ts.isPropertyAssignment(declaration) ||
    ts.isImportSpecifier(declaration) ||
    ts.isExportSpecifier(declaration) ||
    ts.isImportClause(declaration) ||
    // The NAME, not the specifier: `declaration-lifecycle.ts` asks about the
    // identifier an import binds, and an ordinary reference to the same value
    // asks about an identifier too. Both must get the one convention the
    // value physically has, or a program that imports an overloaded-annotated
    // binding disagrees with the module that defines it.
    ts.isIdentifier(declaration)
  if (!declares) return null
  // STATED, not held: `declared` here plays the identical role
  // `declaredValueTypeOf` names -- the ANNOTATED type this overload check
  // exists to compare the physical initializer against (see the header
  // comment above and `physicalInitializerTypeOf`'s `declared` parameter).
  // The census answers "what is held", which is precisely the OTHER half of
  // that comparison; asking it here would make both sides of the check the
  // same question.
  const declared = checker.getTypeAtLocation(declaration)
  return physicalInitializerTypeOf(checker, declaration, declared, parameters)
}

/**
 * The declaration an alias resolves to, or `null` for a node that names none.
 *
 * Both spellings reach here: the import SPECIFIER itself, and the identifier a
 * producer asks about (`declaration-lifecycle.ts` asks `typeAt` about the
 * name, not about the specifier node), so the answer cannot depend on which
 * of the two a caller happens to hold.
 */
const aliasTargetDeclaration = (checker: ts.TypeChecker, node: ts.Node): ts.Declaration | null => {
  const named = ts.isImportSpecifier(node) || ts.isExportSpecifier(node) || ts.isImportClause(node)
  const at = ts.isIdentifier(node) ? node : named ? ts.getNameOfDeclaration(node as ts.Declaration) : undefined
  const symbol = at ? checker.getSymbolAtLocation(at) : undefined
  if (!symbol || (symbol.flags & ts.SymbolFlags.Alias) === 0) return null
  const target = checker.getAliasedSymbol(symbol)
  if (target === symbol) return null
  const targetDeclaration = target.valueDeclaration ?? target.declarations?.[0]
  return targetDeclaration && targetDeclaration !== node ? targetDeclaration : null
}

/**
 * Whether a physical initializer's trailing REST parameter is a sound stand-in
 * for a declared single signature's trailing parameters -- the other shape a
 * member's literal and its annotation can disagree about arity, one level
 * over the overload case this function already handles.
 *
 * hono's own `Hono.fetch`: `fetch: (request, Env?, executionCtx?) => ... =
 * (request, ...rest) => { return this.#dispatch(request, rest[1], rest[0],
 * request.method) }`. `declared` has ONE signature (never overloaded -- the
 * overload branch below does not apply), so the existing gate
 * (`getCallSignatures().length < 2`) correctly stayed out of this case, and
 * the member's published type kept the declared 3-named-parameter signature
 * while the value's OWN parameter slot -- once `parameter-slot.ts`'s
 * `restParameterArrayTypeOf` stopped it publishing a closed record for `rest`
 * -- correctly types it as an array. That left the member and its own
 * allocation naming two different conventions for the identical value: the
 * shape target 3 fixed for the parameter, still open for the member.
 *
 * Publishing the physical (rest-taking) signature here is sound for exactly
 * the same reason `ECMA-262`'s own calling convention makes it sound at
 * every ordinary call site: a rest parameter absorbs whatever a caller
 * actually passed into a real array or tuple, REGARDLESS of whether the
 * positions it absorbs are declared optional or required -- binding is a
 * fact about the call, not about the annotation. A value assignable to the
 * declared type remains callable exactly as before once the member's own
 * type is the rest-taking one, because TypeScript already proved the
 * initializer assignable to `declared` (what let the program compile at
 * all); this does not re-derive that, only decides which signature the
 * member's own type publishes.
 *
 * This used to require the declared tail to be entirely OPTIONAL, which is
 * what told `fetch` (`Env?`, `executionCtx?`) apart from hono's own
 * `render: Renderer = (...args) => {...}` (`Renderer` resolves to
 * `DefaultRenderer`'s ONE REQUIRED parameter). That distinction never traced
 * to a soundness difference -- both shapes have the physical rest parameter
 * absorbing exactly the positions the declared signature's tail names, and
 * `render`'s own inner `this.#renderer(...args)` already resolves through
 * `tuple-spread.ts`'s `tupleSpreadReads` (the CLOSED, all-required tuple
 * path, not the optional-tailed `maxArityTupleSpreadReads` one) -- so a
 * required tail is not a harder case, only a different one. Requiring
 * optionality bought nothing here and left `render` publishing two
 * disagreeing conventions for the same value, the identical shape target 3
 * fixed for `fetch`. Gated narrowly still, to the shape the proof covers:
 *  - `declared` must be a SINGLE signature (the overload branch below owns
 *    two-or-more);
 *  - the physical initializer's LAST parameter must be a rest parameter that
 *    `declared`'s signature does not have at all;
 *  - `declared` must have at least one parameter beyond the physical
 *    signature's fixed prefix, so there is a real tail for the rest to
 *    absorb rather than an equal-arity coincidence.
 */
const restAbsorbsDeclaredOptionalTail = (
  declaredSignature: ts.Signature,
  physicalParameters: ts.NodeArray<ts.ParameterDeclaration>
): boolean => {
  const lastPhysical = physicalParameters[physicalParameters.length - 1]
  if (!lastPhysical || lastPhysical.dotDotDotToken === undefined) return false
  const declaredDeclaration = declaredSignature.declaration
  if (!declaredDeclaration) return false
  // `declaredDeclaration.parameters` widens to include `JSDocParameterTag`
  // for a JSDoc-derived signature, which carries none of the syntax fields
  // below -- fail closed (not a parameter this proof can read) rather than
  // guess at one it cannot.
  if (!declaredDeclaration.parameters.every(ts.isParameter)) return false
  const declaredParameters = declaredDeclaration.parameters as ts.NodeArray<ts.ParameterDeclaration>
  const lastDeclared = declaredParameters[declaredParameters.length - 1]
  if (lastDeclared && lastDeclared.dotDotDotToken !== undefined) return false
  const physicalFixedCount = physicalParameters.length - 1
  if (physicalFixedCount >= declaredParameters.length) return false
  const declaredTail = declaredParameters.slice(physicalFixedCount)
  return declaredTail.length > 0
}

/** An expression with its parentheses removed -- the layer that changes how a write READS without changing what it stores. */
const withoutParens = (node: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(node) ? withoutParens(node.expression) : node)

/**
 * Whether an assignment target can name `member`: `yes` when it provably
 * does, `no` when it provably does not, `open` when nothing here can tell.
 *
 * A COMPUTED target is decided by the checker's own type for the key. hono
 * writes its seven route registrars as `allMethods.forEach((method) => {
 * this[method] = (args1, ...args) => {...} })` (`hono-base.ts`), and
 * `method` is typed by the `as const` array it iterates -- a union of string
 * literals. That union is a guarantee of the same kind every other decision
 * in this compiler rests on: the value at run time IS one of those names.
 * A key typed any wider (`string`, a `for-in` binding, `any`) states nothing
 * about which member it lands on, so it is `open` and the caller refuses.
 */
const assignmentNamesMember = (checker: ts.TypeChecker, target: ts.Expression, member: string): 'yes' | 'no' | 'open' => {
  if (ts.isPropertyAccessExpression(target)) {
    if (target.name.text !== member) return 'no'
    return target.expression.kind === ts.SyntaxKind.ThisKeyword ? 'yes' : 'open'
  }
  if (!ts.isElementAccessExpression(target)) return 'no'
  const key = checker.getTypeAtLocation(target.argumentExpression)
  const arms = key.isUnion() ? key.types : [key]
  if (!arms.every((arm) => arm.isStringLiteral())) return 'open'
  const names = arms.map((arm) => (arm as ts.StringLiteralType).value)
  if (!names.includes(member)) return 'no'
  return target.expression.kind === ts.SyntaxKind.ThisKeyword ? 'yes' : 'open'
}

/**
 * The ONE function literal a class writes into a member it declares with an
 * overload set and no initializer -- `physicalInitializerTypeOf`'s premise
 * for the other spelling of the same allocation.
 *
 * hono's `HonoBase` is the shape: `get!: HandlerInterface<E, 'get', ...>`
 * declares roughly a dozen overloads that join into no single convention, and
 * the cell is filled by the constructor's `allMethods.forEach((method) => {
 * this[method] = (args1: string | H, ...args: H[]) => {...} })`. One arrow is
 * allocated; every route registrar holds it. Read off the annotation instead,
 * the member carried `callable-identity` -- a function the plan knows only by
 * identity -- so `app.get('/', handler)`, the first statement of every hono
 * program, had no invoke path at all
 * (`call-abi:no-invoke-path:callable-identity`).
 *
 * The premise is `physicalInitializerTypeOf`'s verbatim: a function or arrow
 * LITERAL cannot be overloaded, TypeScript already proved this one assignable
 * to every declared overload (which is what let the program typecheck), and
 * whichever overload a CALL matched is a type-level fiction over the single
 * function that exists. Only the spelling differs -- `= <literal>` at the
 * declaration versus `this[k] = <literal>` in the constructor -- and the
 * value allocated is the same either way.
 *
 * Refuses on anything it cannot see to the end of: a second distinct literal
 * (two conventions, and nothing here picks), a non-literal right-hand side (a
 * value whose own convention is a further question), or a target whose key
 * cannot be resolved to names. Scoped to the declaring class's own body, the
 * same scope the initializer arm has -- a write from outside is bound by the
 * declared type exactly as a later write over an initialized member is, and
 * fails closed at that write's own conversion rather than silently here.
 *
 * Gated to a declared OVERLOAD SET, so nothing that already resolves to one
 * convention is re-derived: a member with a single declared signature keeps
 * the checker's answer, and the class layout keeps agreeing with it.
 */
const writtenFunctionLiteralOf = (
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  declared: ts.Type
): ts.ArrowFunction | ts.FunctionExpression | null => {
  if (!ts.isPropertyDeclaration(declaration) || declaration.initializer !== undefined) return null
  if (declared.getCallSignatures().length < 2) return null
  const owner = declaration.parent
  if (!ts.isClassLike(owner)) return null
  const name = declaration.name
  if (!ts.isIdentifier(name) && !ts.isStringLiteralLike(name)) return null
  const member = name.text
  let found: ts.ArrowFunction | ts.FunctionExpression | null = null
  let open = false
  const visit = (node: ts.Node): void => {
    if (open) return
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const names = assignmentNamesMember(checker, withoutParens(node.left), member)
      if (names === 'open') open = true
      else if (names === 'yes') {
        const value = withoutParens(node.right)
        if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) open = true
        else if (found !== null && found !== value) open = true
        else found = value
      }
    }
    ts.forEachChild(node, visit)
  }
  for (const each of owner.members) visit(each)
  return open ? null : found
}

export const physicalInitializerTypeOf = (
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  declared: ts.Type,
  parameters: ParameterBindingCensus = emptyParameterBindingCensus
): ts.Type | null => {
  // An IMPORT of such a binding asks the same question one module over. The
  // specifier is an alias, so the symbol at the import site is the alias's --
  // and its type is the exported name's DECLARED type, every overload of it,
  // never the one function the exporting module actually allocated. hono's
  // `export const parseBody: ParseBody = async (...)` is the case:
  // `utils/body.ts` resolves to the single async arrow (below), and
  // `request.ts`'s `import { parseBody }` resolved to `ParseBody`'s two
  // overloads, so one value had two conventions depending on which module
  // asked -- the two-authorities shape, with the import site refusing.
  const alias = aliasTargetDeclaration(checker, declaration)
  if (alias) return physicalInitializerTypeOf(checker, alias, declared, parameters)
  if (!ts.isPropertyDeclaration(declaration) && !ts.isVariableDeclaration(declaration) && !ts.isPropertyAssignment(declaration)) {
    return null
  }
  const initializer = declaration.initializer ?? writtenFunctionLiteralOf(checker, declaration, declared)
  if (!initializer || (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer))) return null
  const declaredSignatures = declared.getCallSignatures()
  // HOLDS: what the initializer LITERAL physically is, as opposed to
  // `declared`'s stated/annotated type -- the whole distinction this
  // function exists to draw (see the header comment). Asked through the
  // shared authority; a function/arrow literal is rarely `any`-degraded, so
  // this mostly falls straight through to the checker exactly as before,
  // but stays uniform with every other "what does this hold" question.
  const physical = censusedTypeAt(checker, parameters, initializer)
  if (physical.getCallSignatures().length !== 1) return null
  if (declaredSignatures.length >= 2) return physical
  const soleDeclared = declaredSignatures[0]
  if (declaredSignatures.length === 1 && soleDeclared && restAbsorbsDeclaredOptionalTail(soleDeclared, initializer.parameters))
    return physical
  return null
}

/**
 * Whether `type` IS the standard library's `String` wrapper-object interface
 * -- resolved by declaration identity (`isStandardInterfaceType`), which is
 * what this function's own doc comment already claimed of it before this fix:
 * `stringObjectDeclarationOf` (host-protocols.ts) resolves `String` through
 * `checker.resolveName` and compares declaration identity; this used to
 * compare the symbol's own NAME plus "some declaration sits in a `.d.ts`
 * file" instead, which is not the same check -- a program declaring its own
 * ambient `interface String { ... }` (or merely a same-named local one bundled
 * from a `.d.ts`) would satisfy the old test without being the standard
 * wrapper at all. Routed through the shared resolver so the two are one
 * authority rather than a real one and a look-alike.
 */
const isAmbientStringObjectType = (checker: ts.TypeChecker, anchor: ts.Node, type: ts.Type): boolean =>
  isStandardInterfaceType(checker, anchor, 'String', type)

/** The `new` expression an initializer physically is, unwrapped through `as`/type-assertion/parens/non-null -- the layers that change the STATIC view without changing what is allocated. */
const unwrappedAllocation = (node: ts.Expression): ts.NewExpression | null => {
  if (ts.isNewExpression(node)) return node
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
    return unwrappedAllocation(node.expression)
  }
  return null
}

/** Whether `declaration` is a `const` variable declaration -- a `let`/`var` can be reassigned to something that is not a String object, and nothing here re-proves that for every later assignment. */
const isConstVariableDeclaration = (declaration: ts.VariableDeclaration): boolean => {
  const list = declaration.parent
  return ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0
}

const physicalStringObjectTypeOfDeclaringNode = (
  checker: ts.TypeChecker,
  declaration: ts.Node,
  parameters: ParameterBindingCensus = emptyParameterBindingCensus
): ts.Type | null => {
  if (!ts.isVariableDeclaration(declaration) && !ts.isPropertyDeclaration(declaration) && !ts.isPropertyAssignment(declaration)) return null
  const allocation = declaration.initializer ? unwrappedAllocation(declaration.initializer) : null
  if (!allocation) return null
  // HOLDS: what the `new String(...)` expression physically allocates, the
  // same "physical, not declared/stated" question `physicalInitializerTypeOf`
  // asks of a function literal, one type-object over (see the header
  // comment). A `new` expression's own type is essentially never `any`, so
  // this almost always falls straight through to the checker unchanged --
  // asked through the shared authority anyway, for the same uniformity
  // reason, not because a change here was measured to move anything.
  const physical = censusedTypeAt(checker, parameters, allocation)
  return isAmbientStringObjectType(checker, allocation, physical) ? physical : null
}

/**
 * The type a `new String(x)` allocation actually has, when a declaration or a
 * same-module reference to it is annotated with something else.
 *
 * hono's `utils/html.ts`: `const escapedString = new String(value) as
 * HtmlEscapedString`. The declared/annotated type is `HtmlEscapedString =
 * string & HtmlEscaped`, which `deriveIntersection` (representation/derive.ts)
 * deliberately collapses to plain `string` -- correct for the alias in
 * general, and wrong for the one value this expression actually allocates: a
 * String WRAPPER OBJECT with identity, not a primitive. `as` changes only the
 * STATIC view a reader gets; it does not change what `new String(...)`
 * constructs at runtime.
 *
 * `physicalInitializerTypeOf`'s exact shape one level over: that function
 * recovers the one convention a function LITERAL actually has past an
 * overloaded annotation; this recovers the one OBJECT a `new String(...)`
 * expression actually allocates past a widened/cast annotation. Both exist
 * because the checker's type at the BINDING can legitimately differ from the
 * type of the value physically stored there, and both must be asked
 * uniformly at every site that reads the binding back, not only at its
 * declaration -- `structural.ts`'s `typeAt` is exactly that uniform point,
 * for the same reason it already calls `physicalOverloadTypeAt` there. A
 * held cell and every read of it must agree, or a store/read pair would
 * disagree about the binding's own carrier for no reason the program stated.
 *
 * Deliberately narrow, for the identical blast-radius reason
 * `physicalInitializerTypeOf`'s own comment gives for its narrower cases: this
 * does not see through an arbitrary `as`-cast pattern. It fires only when the
 * unwrapped initializer is itself a `new` expression whose resolved type's
 * symbol is literally named `String`, declared ambiently. `Number`/`Boolean`/
 * every other constructor is untouched.
 *
 * A same-module IDENTIFIER reference reaches the same answer by walking to
 * its declaring `VariableDeclaration`, gated to `const` only.
 */
export const physicalStringObjectTypeAt = (
  checker: ts.TypeChecker,
  node: ts.Node,
  parameters: ParameterBindingCensus = emptyParameterBindingCensus
): ts.Type | null => {
  const direct = physicalStringObjectTypeOfDeclaringNode(checker, node, parameters)
  if (direct) return direct
  if (!ts.isIdentifier(node)) return null
  const symbol = checker.getSymbolAtLocation(node)
  const declaration = symbol?.valueDeclaration
  if (!declaration || !ts.isVariableDeclaration(declaration) || !isConstVariableDeclaration(declaration)) return null
  return physicalStringObjectTypeOfDeclaringNode(checker, declaration, parameters)
}

/**
 * The signature a get/set accessor declaration implements, or `null` for a node
 * that is not one.
 *
 * An accessor's name symbol is the *property* it implements, so its type is
 * that property's -- `number` for `get value(): number`. What is allocated at
 * an accessor declaration is the accessor function, whose type is its own
 * signature. Reading the property's type there hands the callable carrier a
 * scalar, and a call through it then has no convention to select at all.
 */
export const accessorSignatureOf = (checker: ts.TypeChecker, node: ts.Declaration): ts.Signature | null => {
  if (!ts.isGetAccessorDeclaration(node) && !ts.isSetAccessorDeclaration(node)) return null
  return checker.getSignatureFromDeclaration(node) ?? null
}

/**
 * The single property/element access a passthrough accessor half reads or
 * writes -- `R.k` / `R['k']` for a receiver `R` that is either a bare `this`
 * or `this.<field>` -- or `null` for anything else. Shared by both halves of
 * `accessorPassthroughAliasOf` so a getter and setter are compared on the
 * identical representation of "the same access".
 */
const passthroughAccessOf = (node: ts.Expression): { readonly receiverField: string | null; readonly key: string } | null => {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return null
  const receiver = node.expression
  const receiverField =
    receiver.kind === ts.SyntaxKind.ThisKeyword
      ? null
      : ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword
        ? receiver.name.text
        : undefined
  if (receiverField === undefined) return null
  const key = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isStringLiteralLike(node.argumentExpression)
      ? node.argumentExpression.text
      : null
  if (key === null) return null
  return { receiverField, key }
}

/**
 * The field a get/set accessor PAIR does nothing but forward to, when both
 * halves are exactly one statement long and agree on the identical access --
 * `get image() { return this.source.data }` / `set image(value) {
 * this.source.data = value }` (three's `Texture`) is the motivating shape.
 * `null` for anything that is not provably this exact shape.
 *
 * This states only the SYNTACTIC fact: which access both bodies name, and
 * that the setter's whole right-hand side is its own parameter untouched --
 * nothing here asks whether the target the access names is itself a plain
 * field, whether it even exists, or whether some sibling class overrides
 * either half differently. Those are per-owner, per-family questions that
 * need the checker and the class family's own closure, and belong beside the
 * caller that already asks them one owner at a time --
 * `accessorPassthroughDataMemberOf` (`flow/source-class-data.ts`), next to
 * `isSourceDataDeclaration`, which this function's result is deliberately
 * NOT allowed to bypass: a target that is itself an accessor still refuses.
 *
 * Deliberately narrow, for the same reason `physicalStringObjectTypeAt` above
 * gives: guessing at a looser shape (a body with an early return, a
 * multi-statement setter, a right-hand side that merely INCLUDES the
 * parameter) risks calling something a passthrough that quietly does more,
 * which would make a read of the alias silently skip real behavior.
 */
export const accessorPassthroughAliasOf = (
  getter: ts.GetAccessorDeclaration,
  setter: ts.SetAccessorDeclaration
): { readonly receiverField: string | null; readonly key: string } | null => {
  const getterStatements = getter.body?.statements
  if (!getterStatements || getterStatements.length !== 1) return null
  const onlyReturn = getterStatements[0]!
  if (!ts.isReturnStatement(onlyReturn) || !onlyReturn.expression) return null
  const read = passthroughAccessOf(onlyReturn.expression)
  if (!read) return null

  const setterStatements = setter.body?.statements
  if (!setterStatements || setterStatements.length !== 1) return null
  const onlyAssignment = setterStatements[0]!
  if (!ts.isExpressionStatement(onlyAssignment)) return null
  const assignment = onlyAssignment.expression
  if (!ts.isBinaryExpression(assignment) || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null
  const write = passthroughAccessOf(assignment.left)
  if (!write || write.receiverField !== read.receiverField || write.key !== read.key) return null

  // The whole RHS must be exactly the setter's own sole parameter, so nothing
  // but the value the caller wrote ever reaches the receiver's real storage.
  const parameter = setter.parameters[0]
  if (!parameter || setter.parameters.length !== 1 || !ts.isIdentifier(parameter.name)) return null
  if (!ts.isIdentifier(assignment.right) || assignment.right.text !== parameter.name.text) return null

  return read
}

/**
 * The MEMBER a passthrough accessor pair forwards to -- the storage half of
 * the syntactic fact `accessorPassthroughAliasOf` states.
 *
 * three's `Texture` writes `get image() { return this.source.data }` and the
 * matching setter, and annotates the GETTER `@type {?Object}`. That annotation
 * is an upper bound on what may be read back, never a statement about what the
 * slot holds -- the slot IS `Source.data`, and nothing else can be. But
 * `Object | null` is not `any`/`void`/`never`, so every authority gated on
 * `isUnusableEvidence` treats it as a final answer and never asks the census
 * that knows better. `Texture.image` is read dozens of times across
 * `WebGLTextures.js` alone, and each read boxed.
 *
 * The receiver type is taken from the getter's OWN access node rather than
 * rebuilt from the owning class's symbol: the node is what the program
 * actually wrote, the checker already types it in its real lexical position,
 * and reconstructing an instance type from a class declaration would answer a
 * different question for a constructor function or a class expression.
 *
 * Fails closed on a target that is itself an accessor. Forwarding to a second
 * accessor is not storage -- it is another body that may do anything -- and
 * admitting it is how a passthrough proof turns into a chain of guesses.
 */
export const accessorPassthroughMemberTargetOf = (
  checker: ts.TypeChecker,
  symbol: ts.Symbol
): { readonly symbol: ts.Symbol; readonly declaration: ts.Declaration } | null => {
  const declarations = symbol.declarations ?? []
  const getter = declarations.find(ts.isGetAccessorDeclaration)
  const setter = declarations.find(ts.isSetAccessorDeclaration)
  if (!getter || !setter || !accessorPassthroughAliasOf(getter, setter)) return null
  const onlyReturn = getter.body?.statements[0]
  if (!onlyReturn || !ts.isReturnStatement(onlyReturn) || !onlyReturn.expression) return null
  const access = onlyReturn.expression
  if (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) return null
  const key = ts.isPropertyAccessExpression(access)
    ? access.name.text
    : ts.isStringLiteralLike(access.argumentExpression)
      ? access.argumentExpression.text
      : null
  if (key === null) return null
  const receiver = checker.getApparentType(checker.getTypeAtLocation(access.expression))
  if (isUninformativeReceiver(receiver)) return null
  const target = checker.getPropertyOfType(receiver, key)
  const declaration = target?.declarations?.[0]
  if (!target || !declaration) return null
  if (ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration)) return null
  return { symbol: target, declaration }
}

/** A receiver the checker could not type states nothing about what its members hold. */
const isUninformativeReceiver = (type: ts.Type): boolean =>
  (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0

/**
 * The one signature an OVERLOADED function or method's implementation
 * declares, or `null` when the node is not an overload set's implementation.
 *
 * `class HonoRequest { param(key: string): string; param(): Record<...>;
 * param(key?: string): unknown { ... } }` (hono's `request.ts`) is the shape,
 * and it is `physicalInitializerTypeOf`'s twin at TypeScript's other spelling
 * of the same thing. Asked through the symbol, the type is every OVERLOAD
 * signature and never the implementation's -- that is the checker's rule, and
 * it is right for call resolution -- so `sharedAbiOf` (derive.ts) sees N
 * conventions and refuses. But the implementation is the only body that ever
 * runs, and it declares exactly one; N is a fact about how the method may be
 * CALLED, never about the single function that exists.
 *
 * `accessorSignatureOf` above already reaches past the symbol for the same
 * class of reason (an accessor's name symbol is the property, not the
 * function), and this asks the checker the identical way -- from the
 * declaration node rather than the symbol.
 *
 * Resolve the body's declaration from the symbol: a call-site value declaration
 * can be the first overload, which has no body of its own. The same function
 * object still implements the symbol's one body.
 *
 * ⚠ A second DECLARATION is not a second overload. TypeScript's JS expando
 * inference makes `SourceNode.fromStringWithSourceMap = function ...` a
 * declaration of the `SourceNode` SYMBOL, so a pre-class constructor function
 * with any static on it has two declarations and no overloads at all. Reading
 * the signature off its body then returns the CALL signature alone and throws
 * away the construct signature TS's JS inference attached to the symbol -- the
 * declaration's cell became `function-value-dispatch` while every reference
 * stayed `function-and-constructor`, which is 96 rows of tsc's self-compile
 * concentrated in the `source-map` packages, and a two-authorities defect of
 * exactly the kind this compiler exists to avoid. So the set is recognized by
 * an actual overload being present: a method/function declaration with NO
 * body, which is the only thing an overload signature can be.
 */
export const implementationSignatureOf = (checker: ts.TypeChecker, node: ts.Declaration): ts.Signature | null => {
  if (!ts.isMethodDeclaration(node) && !ts.isFunctionDeclaration(node)) return null
  const name = ts.getNameOfDeclaration(node)
  const symbol = name ? checker.getSymbolAtLocation(name) : undefined
  const declarations = symbol?.getDeclarations() ?? []
  const overloaded = declarations.some(
    (declaration) => (ts.isMethodDeclaration(declaration) || ts.isFunctionDeclaration(declaration)) && declaration.body === undefined
  )
  if (!overloaded) return null
  const implementation = declarations.find(
    (declaration): declaration is ts.MethodDeclaration | ts.FunctionDeclaration =>
      (ts.isMethodDeclaration(declaration) || ts.isFunctionDeclaration(declaration)) && declaration.body !== undefined
  )
  return implementation ? (checker.getSignatureFromDeclaration(implementation) ?? null) : null
}

/**
 * The signature a `?`-marked class METHOD implements, when it has a real
 * body -- or `null` when the node is not one.
 *
 * `bar?(): string { ... }` inside a class is not a member that may or may
 * not be defined: `DefineMethod` runs unconditionally during
 * `ClassDefinitionEvaluation`, so the method exists on every instance the
 * moment the class is instantiated. The `?` states a fact about READING
 * `bar` through a structural interface that does not require it -- a
 * caller who only knows the interface may see `undefined` -- never a fact
 * about whether THIS declaration's own function object gets created.
 *
 * `declaredValueTypeOf` (above) asks the checker for the member SYMBOL's
 * type, and for an optional member the checker answers `T | undefined`
 * whether the query is symbol- or node-based -- `getTypeOfSymbolAtLocation`
 * and `getTypeAtLocation` on the declaration itself agree, verified
 * directly against the checker rather than assumed. That answer is
 * CORRECT for "what does reading this member give you" and simply the
 * wrong question for an ALLOCATION's own shape: `class-lifecycle.ts`'s
 * `allocateFunctionObject` asks `valueTypeAt` for what `DefineMethod`
 * creates, not for what a later read of the member sees.
 *
 * `accessorSignatureOf` and `implementationSignatureOf` above already
 * reach past the symbol for the identical reason (an accessor's/overload
 * set's symbol answers a different question than the one physical function
 * being allocated); this is the same move for the third case `questionToken`
 * introduces. Gated on there being a body, so an interface or `.d.ts`
 * member SIGNATURE (`ts.isMethodSignature`) is untouched: that node
 * allocates nothing at all, and `?` there states exactly what it says --
 * an implementer MAY omit the member.
 */
export const optionalMethodSignatureOf = (checker: ts.TypeChecker, node: ts.Declaration): ts.Signature | null => {
  if (!ts.isMethodDeclaration(node)) return null
  if (node.questionToken === undefined) return null
  if (node.body === undefined) return null
  return checker.getSignatureFromDeclaration(node) ?? null
}

/**
 * The accessor pair behind an *object literal's* member, or `null`.
 *
 * Restricted to object literals on purpose. A class accessor is installed by a
 * class-evaluation event and read back from the class layout
 * (`projection/classes.ts`), so naming it here as well would be a second
 * authority over one member. An accessor declared in an interface or a `.d.ts`
 * has no body at all, so there is nothing for a reader to call and it stays an
 * ordinary member of a shape the host implements.
 */
export const literalAccessorOf = (
  symbol: ts.Symbol,
  identities: { readonly declarationIdOf: (declaration: ts.Declaration) => DeclarationId }
): StructuralAccessor | null => {
  const declarations = symbol.declarations ?? []
  const getter = declarations.find((node) => ts.isGetAccessorDeclaration(node) && ts.isObjectLiteralExpression(node.parent))
  const setter = declarations.find((node) => ts.isSetAccessorDeclaration(node) && ts.isObjectLiteralExpression(node.parent))
  if (!getter && !setter) return null
  return {
    getter: getter ? identities.declarationIdOf(getter) : null,
    setter: setter ? identities.declarationIdOf(setter) : null
  }
}

/**
 * The one signature an OVERLOADED CONSTRUCTOR's implementation declares, or
 * `null` when the class does not overload its constructor.
 *
 * `implementationSignatureOf` above states the rule; this is the same fact at
 * TypeScript's other spelling of it. `class Long { constructor(low: number,
 * high?: number, unsigned?: boolean); constructor(value: bigint, unsigned?:
 * boolean); constructor(value: string, unsigned?: boolean); constructor(
 * lowOrValue: number | bigint | string = 0, highOrUnsigned?: number | boolean,
 * unsigned?: boolean) { ... } }` (bson's `long.ts`) declares three ways to
 * CALL `new Long`, and exactly one frame the body runs with. `sharedAbiOf`
 * (derive.ts), asked for a convention the three share, correctly finds none
 * and refuses -- and refusing is wrong here for the same reason it was wrong
 * for a method: the three are views of one physical constructor, and the
 * implementation is the one that states its frame.
 *
 * A constructor has no name, so the symbol test `implementationSignatureOf`
 * uses cannot be spelled here. The class's own member list is the same
 * question asked where it can be answered: an overload set is precisely a
 * class carrying more than one `ConstructorDeclaration`, of which at most one
 * has a body.
 *
 * Gated on the class declaring no type parameters. `getSignatureFromDeclaration`
 * answers from the declaration, so its signature is the UNINSTANTIATED one;
 * for a generic class that would silently drop the instantiation the
 * constructor type was reached through. Such a class keeps refusing exactly as
 * it does today rather than being answered with the wrong frame.
 */
export const constructorImplementationSignatureOf = (checker: ts.TypeChecker, declaration: ts.Node): ts.Signature | null => {
  if (!ts.isClassLike(declaration)) return null
  if ((declaration.typeParameters ?? []).length > 0) return null
  const constructors = declaration.members.filter(ts.isConstructorDeclaration)
  if (constructors.length < 2) return null
  const implementation = constructors.find((one) => one.body !== undefined)
  return implementation ? (checker.getSignatureFromDeclaration(implementation) ?? null) : null
}

/**
 * The source of a mapped type that changes only MODIFIERS -- `Mutable<T>`,
 * `Readonly<T>` -- or `null` for every mapped type that changes what the
 * object holds.
 *
 * `type Mutable<T extends object> = { -readonly [K in keyof T]: T[K] }`
 * (tsc's `utilities.ts`) states the same storage as `T`: `readonly` is a
 * checker-side permission, not a physical fact, and every field keeps its own
 * key and its own type. So `Mutable<Node>` IS `Node`, and walking it as a
 * fresh anonymous object was not merely wasteful -- it re-entered the alias
 * once per nested instantiation and refused with "type alias Mutable
 * re-entered with no equivalent active instantiation", 4,503 unmet
 * obligations on the tsc self-compile, all of them behind
 * `nodeFactory.ts`'s `update<T extends Node>(updated: Mutable<T>, original:
 * T)`.
 *
 * Every other mapped type is refused here, by construction rather than by a
 * name list:
 *
 * - `Partial<T>`/`Required<T>` carry a `?` modifier, which IS physical (a
 *   presence bit), so a question token of either sign disqualifies.
 * - `Pick<T, K>`/`Record<K, V>` constrain the key variable to something other
 *   than `keyof <source>`, so they change the key set.
 * - A remapped key (`as`) changes the names, and a body that is anything but
 *   the identity `T[K]` changes the values.
 *
 * Answered through the ALIAS's own type arguments: an instantiation's type
 * arguments are where the source actually is (the mapped type's own instance
 * carries the substitution internally, and the checker does not publish it).
 * A mapped type reached without an alias keeps the general path.
 */
export const modifierOnlyMappedSourceOf = (type: ts.Type): ts.Type | null => {
  const alias = type.aliasSymbol
  const suppliedArguments = type.aliasTypeArguments ?? []
  if (!alias || suppliedArguments.length === 0) return null
  if ((type.flags & ts.TypeFlags.Object) === 0 || ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) === 0) return null
  const declaration = (alias.declarations ?? []).find(ts.isTypeAliasDeclaration)
  if (!declaration || !ts.isMappedTypeNode(declaration.type)) return null
  const mapped = declaration.type
  if (mapped.nameType !== undefined || mapped.questionToken !== undefined || mapped.type === undefined) return null
  if (!ts.isIndexedAccessTypeNode(mapped.type)) return null
  const constraint = mapped.typeParameter.constraint
  if (!constraint || !ts.isTypeOperatorNode(constraint) || constraint.operator !== ts.SyntaxKind.KeyOfKeyword) return null
  const sourceName = typeReferenceName(constraint.type)
  if (sourceName === null || sourceName !== typeReferenceName(mapped.type.objectType)) return null
  if (typeReferenceName(mapped.type.indexType) !== mapped.typeParameter.name.text) return null
  const position = (declaration.typeParameters ?? []).findIndex((parameter) => parameter.name.text === sourceName)
  const source = position < 0 ? undefined : suppliedArguments[position]
  // A source the caller left to the parameter's own default is not in the
  // argument list; the general path answers it.
  return source ?? null
}

/** The single identifier a type reference names, or `null` for every compound type node. */
const typeReferenceName = (node: ts.TypeNode): string | null =>
  ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeArguments === undefined ? node.typeName.text : null

/**
 * What the IMPLEMENTERS of a declared member prove about it, keyed on the
 * declared member's own symbol.
 *
 * `literalAccessorOf` above answers for a literal laid out as ITSELF. This
 * answers the other case -- a literal laid out as a contextual DECLARED type --
 * for the two questions whose answer lives in the implementation rather than in
 * the declaration, and it answers both from ONE walk because both are the same
 * lookup: which literal members implement which declared member.
 *
 *  - `accessorBodiesOf`: `interface C { get next(): T }` has no body, so the
 *    interface's member is ordinary data of a shape the host implements, and
 *    the implementing literal's `get next() { ... }` had nowhere to install its
 *    body -- `producers/allocations.ts` refuses that by name rather than
 *    allocating a record with an unset callable slot.
 *  - `implementationReadsReceiver`: a `MethodSignature` has no body, so there is
 *    no `this`-reading body to gate a receiver on the way an object literal's
 *    own method is gated. The implementers have one. Without this, the SPELLING
 *    of the declaration decided the calling convention: the literal's
 *    `next() { return this.label }` took a receiver and the interface member it
 *    satisfies took none, and storing one into the other is a conversion between
 *    two conventions that C++ does not have.
 *
 * Keyed on the declared member's own DECLARATION (`declaredMemberKeyOf` below,
 * which says why a symbol is not a stable identity for one member), and global,
 * for one reason each:
 *
 *  - `RecordAccessor.getter` is one `FunctionId` and an accessor occupies no
 *    storage, so "is this member an accessor" is a fact about the TYPE while
 *    "whose body backs it" is a fact about the ALLOCATION. Keying off the layout
 *    site would silently hand every allocation the first implementer's body,
 *    because shapes are interned by type; putting the bodies in the interning
 *    key would mint two shapes for one declared type, which then could not
 *    convert to each other though the program says they are the same type.
 *  - so the only sound answer is a program-wide one that REFUSES when two
 *    implementers of one named type disagree. A conflicted member is left out
 *    entirely, which returns it to the named refusal -- fail-closed, never
 *    "whichever was walked first".
 *
 * Why a census and not a branch: granting EVERY interface method a receiver is
 * a measured regression (`structural-receiver.ts` records it, twice) -- it costs
 * `overload-set-as-value.ts` and `control-flow-structural-view.ts`, whose
 * members no implementer reads a receiver for. The proof has to come from an
 * implementation, which is what this supplies.
 *
 * Matched on the contextual type's own property SYMBOL, never on the written
 * name, so a computed well-known-symbol member is tested exactly as a written
 * one is.
 */
export interface DeclaredMemberCensus {
  readonly accessorBodiesOf: (symbol: ts.Symbol) => StructuralAccessor | null
  readonly implementationReadsReceiver: (symbol: ts.Symbol) => boolean
  readonly declaredMemberImplementedBy: (name: ts.PropertyName) => ts.Symbol | null
}

/**
 * The identity a declared member is censused under: its own DECLARATION, never
 * the `ts.Symbol` a caller happens to be holding.
 *
 * ONE declared member does not have one symbol. `instantiateSymbol` mints a
 * fresh transient symbol for a generic type's member, EXCEPT when that member's
 * type is already resolved and provably free of type variables, where it hands
 * the original back untouched -- so which of the two objects a caller receives
 * for `interface WSContextInit<T> { readyState: WSReadyState }` depends on
 * nothing the program states: only on whether anything had resolved
 * `readyState`'s type before that instantiation's members were asked for.
 * hono's `WSContext` is the case that proved it. This walk recorded the
 * getter `@hono/node-server`'s `new WSContext<WebSocketLike>({ ...,
 * get readyState() { return ws.readyState }, ... })` supplies under the
 * DECLARATION's own symbol, and `structural-parts.ts` asked with the
 * INSTANTIATED one (its `target` is literally the symbol this walk recorded
 * under), so the census answered `null` and `producers/allocations.ts` refused
 * the whole allocation: "an object literal accessor whose allocated shape
 * declares the member as ordinary data has nowhere to install its body".
 *
 * The declaration is what survives instantiation: an instantiated symbol
 * carries its target's `declarations` unchanged, so every spelling of one
 * member -- the declaration's own symbol and every instantiation of it --
 * lands on one entry. Keying here rather than following `links.target` also
 * keeps this to the public API; `target` is checker-internal and undeclared.
 *
 * Fail-closed is strengthened, not weakened: two instantiations of one generic
 * declared member now share an entry, so two implementers that disagree
 * CONFLICT and both return to the named refusal, instead of each silently
 * keeping whichever symbol object the checker happened to mint for it.
 *
 * A symbol with no declaration at all -- a synthesized union member -- keys
 * under itself, exactly as stable as it was.
 */
type DeclaredMemberKey = ts.Declaration | ts.Symbol

const declaredMemberKeyOf = (symbol: ts.Symbol): DeclaredMemberKey => symbol.declarations?.[0] ?? symbol

export const emptyDeclaredMemberCensus: DeclaredMemberCensus = {
  accessorBodiesOf: () => null,
  implementationReadsReceiver: () => false,
  declaredMemberImplementedBy: () => null
}

export const censusDeclaredMembers = (
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  identities: { readonly declarationIdOf: (declaration: ts.Declaration) => DeclarationId },
  readsReceiver: (body: ts.Node) => boolean,
  reachable: ProgramReachability
): DeclaredMemberCensus => {
  const accessors = new Map<DeclaredMemberKey, { getter: DeclarationId | null; setter: DeclarationId | null }>()
  const conflicted = new Set<DeclaredMemberKey>()
  const receivers = new Set<DeclaredMemberKey>()
  const implemented = new Map<ts.PropertyName, ts.Symbol>()

  const recordAccessor = (declared: ts.Symbol, getter: DeclarationId | null, setter: DeclarationId | null): void => {
    const key = declaredMemberKeyOf(declared)
    const existing = accessors.get(key)
    if (existing === undefined) {
      accessors.set(key, { getter, setter })
      return
    }
    // A second implementer of one declared member. Identical bodies are the
    // same literal reached twice; different ones are two objects that cannot
    // share one interned shape, and neither may be preferred over the other.
    if (existing.getter !== getter || existing.setter !== setter) conflicted.add(key)
  }

  /** The declared member this literal member implements, or `null`. */
  const declaredMemberOf = (literal: ts.ObjectLiteralExpression, name: ts.PropertyName): ts.Symbol | null => {
    const own = checker.getSymbolAtLocation(name)
    if (!own) return null
    const contextual = checker.getContextualType(literal)
    if (!contextual) return null
    const declared = contextual.getProperties().find((candidate) => candidate.escapedName === own.escapedName)
    // No declared member, or the contextual type IS this literal's own shape --
    // `literalAccessorOf` already answers that one, and restating it here would
    // be the second authority this census exists to avoid. Compared through the
    // same key the census is built on, for the reason `declaredMemberKeyOf`
    // gives: "the literal's own member" is a fact about the DECLARATION, and a
    // contextual type that is this literal's own shape, instantiated, would
    // otherwise slip past an identity test on the symbol object.
    if (!declared || declaredMemberKeyOf(declared) === declaredMemberKeyOf(own)) return null
    implemented.set(name, declared)
    return declared
  }

  /** Whether a function-like value declares its own `this` parameter. */
  const declaresReceiver = (expression: ts.Expression): boolean =>
    ts.isFunctionExpression(expression) &&
    expression.parameters.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.escapedText === 'this')

  /**
   * Whether the value a getter hands back carries a receiver.
   *
   * `get next(): () => Step { return function (this: GetterCursor) { ... } }`
   * stores a receiver-carrying callable into a member the program spelled
   * `readonly next: () => Step`. The declaration says nothing about the frame;
   * the value stored into it does, exactly as a method body does for a
   * `MethodSignature`. Only the getter's OWN returns count -- a `return` inside
   * a nested ordinary function belongs to that function, not to this one -- so
   * the walk stops at every construct that introduces its own frame, which is
   * the same boundary `bodyReadsThis` draws.
   */
  const returnsReceiverCarrier = (body: ts.Node): boolean => {
    let found = false
    const visit = (node: ts.Node): void => {
      if (found) return
      if (ts.isReturnStatement(node)) {
        if (node.expression && declaresReceiver(node.expression)) found = true
        return
      }
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isClassLike(node)
      ) {
        return
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(body, visit)
    return found
  }

  const visitLiteral = (literal: ts.ObjectLiteralExpression): void => {
    for (const property of literal.properties) {
      if (ts.isMethodDeclaration(property)) {
        if (!property.body || !readsReceiver(property.body)) continue
        const declared = declaredMemberOf(literal, property.name)
        if (declared) receivers.add(declaredMemberKeyOf(declared))
        continue
      }
      if (ts.isPropertyAssignment(property)) {
        // The ES5 spelling of the same store: a function VALUE placed in a
        // member the declaration spells receiver-free.
        if (!declaresReceiver(property.initializer)) continue
        const held = declaredMemberOf(literal, property.name)
        if (held) receivers.add(declaredMemberKeyOf(held))
        continue
      }
      if (!ts.isGetAccessorDeclaration(property) && !ts.isSetAccessorDeclaration(property)) continue
      const declared = declaredMemberOf(literal, property.name)
      if (!declared) continue
      if (ts.isGetAccessorDeclaration(property) && property.body && returnsReceiverCarrier(property.body))
        receivers.add(declaredMemberKeyOf(declared))
      const own = checker.getSymbolAtLocation(property.name)
      // The pair is found by SYMBOL too: a computed `[Symbol.iterator]` getter
      // and setter share one symbol and would compare equal by text only by
      // accident.
      const pairs = literal.properties.filter(
        (node): node is ts.AccessorDeclaration =>
          (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && checker.getSymbolAtLocation(node.name) === own
      )
      const getter = pairs.find(ts.isGetAccessorDeclaration)
      const setter = pairs.find(ts.isSetAccessorDeclaration)
      recordAccessor(declared, getter ? identities.declarationIdOf(getter) : null, setter ? identities.declarationIdOf(setter) : null)
    }
  }

  // `recordAccessor` fails closed the moment two DIFFERENT declaration ids
  // implement the same declared member (`existing.getter !== getter`), even
  // when both bodies are textually identical -- two AST nodes are never one
  // id. An unreached platform adapter counts as a second implementer just as
  // readily as a reached one: hono's `WSContext.readyState` getter is
  // implemented by the Node adapter's `websocket.ts` AND, unreached in a
  // Node program, by `adapter/deno/websocket.ts` and
  // `adapter/cloudflare-workers/websocket.ts` -- three distinct getter
  // declarations for one declared member, which conflicts the symbol and
  // sends every implementer's `accessorBodiesOf` to `null`, even the one
  // program that actually runs. Restricting the walk to what `reachable`
  // keeps is the same fix `parameter-bindings.ts`'s census family already
  // took for the identical shape of bug.
  const walk = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) visitLiteral(node)
    ts.forEachChild(node, walk)
  }
  for (const file of sourceFiles) forEachReachableStatement(reachable, file, walk)

  return {
    accessorBodiesOf: (symbol) => {
      const key = declaredMemberKeyOf(symbol)
      if (conflicted.has(key)) return null
      const bodies = accessors.get(key)
      return bodies === undefined ? null : { getter: bodies.getter, setter: bodies.setter }
    },
    implementationReadsReceiver: (symbol) => receivers.has(declaredMemberKeyOf(symbol)),
    declaredMemberImplementedBy: (name) => implemented.get(name) ?? null
  }
}
