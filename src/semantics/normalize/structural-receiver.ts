import ts from 'typescript'

// Whether a function-like body reads `this` anywhere in its OWN scope -- an
// arrow function is walked through (lexical `this`, so an arrow nested
// inside a method still reads the method's receiver), but a nested ordinary
// function/method/accessor/class introduces its own `this` binding and is
// not descended into.
/**
 * The first `this` a function-like body reads in its OWN scope, or `null`.
 *
 * Scoping rules are `bodyReadsThis`'s exactly -- an arrow is walked through,
 * an ordinary nested function is not -- so the keyword this returns is one the
 * enclosing declaration's own frame supplies. Callers need the NODE, not the
 * boolean, when the answer they want is the checker's type of that receiver.
 */
export const firstOwnThisKeyword = (node: ts.Node): ts.Node | null => {
  let found: ts.Node | null = null
  const visit = (n: ts.Node): void => {
    if (found) return
    if (n.kind === ts.SyntaxKind.ThisKeyword) {
      found = n
      return
    }
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n) ||
      ts.isClassLike(n)
    ) {
      return
    }
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(node, visit)
  return found
}

/**
 * The type of a `this` read inside an object literal member when the
 * literal's CONTEXT, not the literal, types it -- or `null` for an ordinary
 * member.
 *
 * TypeScript types a literal member's `this` as the literal unless the
 * contextual type carries a `ThisType<T>` marker, and the standard library
 * puts one on every property descriptor: `Object.defineProperty`'s third
 * parameter is `PropertyDescriptor & ThisType<any>`. That is the language
 * stating a fact, not a gap in the checker: a descriptor's `get` or `value`
 * function is installed onto the defineProperty TARGET and entered with
 * whatever object the later lookup resolved on -- `@hono/node-server`
 * installs `text()` onto its request prototype this way, and the object that
 * reaches it is a request, never the descriptor literal. Taking the literal
 * as the receiver declared a convention whose frame is the descriptor record,
 * so the dynamic call through the installed property refused the request it
 * was handed at runtime.
 *
 * Only the `any` answer is read, and only when the literal HAS a context that
 * is not itself `any`: a JS literal with no context also reads `any` at the
 * keyword, but there nothing says the receiver is anyone but the literal
 * (`local-bindings.ts`'s `thisValueTypeOf`). What remains is exactly the
 * declared dynamic boundary, so the frame and the read both take the
 * checker's own `any` -- `structural-receiver.ts` for the frame,
 * `local-bindings.ts` for the read.
 */
export const contextTypedLiteralThisOf = (
  checker: ts.TypeChecker,
  literal: ts.ObjectLiteralExpression,
  keyword: ts.Node
): ts.Type | null => {
  const contextual = checker.getContextualType(literal)
  if (!contextual || (contextual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return null
  const receiver = checker.getTypeAtLocation(keyword)
  return (receiver.flags & ts.TypeFlags.Any) === 0 ? null : receiver
}

export const bodyReadsThis = (node: ts.Node, includeSuper = false): boolean => {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (n.kind === ts.SyntaxKind.ThisKeyword || (includeSuper && n.kind === ts.SyntaxKind.SuperKeyword)) {
      found = true
      return
    }
    // A nested class's heritage and computed names evaluate in the outer
    // scope. Retain the static receiver conservatively for that boundary.
    if (includeSuper && ts.isClassLike(n)) {
      found = true
      return
    }
    if (includeSuper && (ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n))) {
      if (ts.isComputedPropertyName(n.name)) visit(n.name.expression)
      return
    }
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n) ||
      ts.isClassLike(n)
    ) {
      return
    }
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(node, visit)
  return found
}

/**
 * The receiver a signature is invoked with, when the language supplies one
 * that the type system never spells.
 *
 * A non-static class member's `this` is the class instance -- that is what
 * `[[Call]]` binds -- but TypeScript records a `thisParameter` only where one
 * was written down. Reading only the written one leaves every method with a
 * convention that declares no receiver, and a body that then reads `this`
 * from a frame slot its own signature says does not exist.
 *
 * An interface or object-type method member (`ts.MethodSignature`) has the
 * same gap in principle -- `{ start(): boolean }`'s `[[Call]]` still binds
 * whatever object a property access resolved on -- but extending this to
 * that case was tried and reverted: an object-type method's implicit
 * receiver is the very type that contains it, and for an *anonymous* object
 * type (no declared name to anchor a cycle on, unlike a class or interface)
 * that is a genuine self-reference with no nominal carrier for
 * `representation/derive.ts` to fall back on -- it hit that deriver's
 * "recurs without a nominal carrier" guard rather than a carrier. Solving it
 * needs a nominal carrier for a self-referential anonymous shape, which
 * `deriveObject` does not have and this function cannot manufacture.
 */
import { emptyDeclaredMemberCensus, type DeclaredMemberCensus } from './structural-declarations.js'

export const createReceiverResolver = (
  checker: ts.TypeChecker,
  layoutTypeAt: (node: ts.Node) => ts.Type,
  declaredMembers: DeclaredMemberCensus = emptyDeclaredMemberCensus
) => {
  /**
   * The member declaration this literal method IMPLEMENTS -- the one the
   * record field's own carrier is built from.
   *
   * ONE authority with two consumers, and they are the two halves of the same
   * store: `declaredMemberReceiverOf` below asks it which receiver the
   * convention carries, and `structural-parts.ts`'s `signatureOf` asks it
   * which RESULT the convention returns for a literal method that annotates
   * none. Both exist because the field and the value assigned into it are
   * derived from different declarations, and any component of the convention
   * the two derive separately is a store C++ has no conversion for.
   *
   * A record field's C++ carrier comes from the member signature of the type
   * the literal is checked against -- for `type Demo = { render(t: number):
   * void }` that is the `MethodSignature`, which the type-literal branch below
   * gives a receiver. The literal's own `render(t) { ... }` derives its
   * callable from its `MethodDeclaration` instead, and the `bodyReadsThis`
   * gate below answers that one `null` whenever the body happens not to
   * mention `this`. Two rules, one member: the field is
   * `CallableObject<void(Self, double)>` and the value assigned into it is
   * `CallableObject<void(double)>`, which is not a conversion C++ has -- the
   * emitted unit is rejected at the store. (`examples/canvas-3d-cube`'s
   * `createCanvasCubeDemo` is exactly this; so is a 20-line reproducer.)
   *
   * So when the body does not settle the question, the DECLARED member does --
   * by asking this same function about that member's own declaration, so there
   * is one rule rather than a second copy of it here. That answer is `null`
   * for every shape the branches below refuse (an interface member, a type
   * literal with no enclosing alias), which is what keeps this additive: a
   * literal whose declared member carries no receiver still derives none, and
   * a literal with no contextual type at all is untouched.
   */
  const declaredMemberSignatureOf = (declaration: ts.MethodDeclaration, literal: ts.ObjectLiteralExpression): ts.MethodSignature | null => {
    const contextual = checker.getContextualType(literal)
    if (!contextual) return null
    // Matched on the member's own SYMBOL, not on its written name. A computed
    // well-known-symbol member (`[Symbol.iterator]() { ... }`) has no
    // identifier or string name to look up, and reading only the two written
    // spellings left exactly that member unmatched -- so a cursor factory
    // whose body never says `this` took no receiver while the member it
    // implements (`type TypedSource = { [Symbol.iterator](): TypedCursor }`,
    // whose alias branch below DOES give one) took the source's, and the two
    // conventions for one member had no conversion between them
    // (`typed-custom-iterator-close.ts`). `escapedName` is the checker's own
    // key for both sides, `__@iterator` included, so the two are compared the
    // way the checker compares them rather than by re-deriving a name.
    const own = checker.getSymbolAtLocation(declaration.name)
    if (!own) return null
    const member = contextual.getProperties().find((candidate) => candidate.escapedName === own.escapedName)
    return member?.declarations?.find(ts.isMethodSignature) ?? null
  }
  const declaredMemberReceiverOf = (declaration: ts.MethodDeclaration, literal: ts.ObjectLiteralExpression): ts.Type | null => {
    const signature = declaredMemberSignatureOf(declaration, literal)
    return signature ? implicitReceiverOf(signature) : null
  }
  /**
   * The ordinary function whose `this` a `this.X = function () {}` initializer
   * is entered with -- or `null` when the function is not installed that way.
   *
   * Only an ordinary function/method introduces a `this` binding, so an arrow
   * between the assignment and the host is walked THROUGH (its `this` is the
   * host's), exactly as `bodyReadsThis` walks through one. The nearest such
   * host is the answer even when the assignment is nested inside another
   * `this.Y = function () {}`: that inner function is then the object whose
   * `this` the assignment writes.
   */
  const installedThisMethodHostOf = (declaration: ts.FunctionExpression | ts.FunctionDeclaration): ts.SignatureDeclaration | null => {
    const assignment = declaration.parent
    if (!ts.isBinaryExpression(assignment) || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null
    if (assignment.right !== declaration) return null
    const target = assignment.left
    if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return null
    if (target.expression.kind !== ts.SyntaxKind.ThisKeyword) return null
    for (let scope: ts.Node | undefined = assignment.parent; scope; scope = scope.parent) {
      if (ts.isFunctionDeclaration(scope) || ts.isFunctionExpression(scope) || ts.isMethodDeclaration(scope)) return scope
      if (ts.isClassLike(scope) || ts.isSourceFile(scope)) return null
    }
    return null
  }

  /**
   * The constructor function whose OWN "prototype" object this function
   * expression/declaration is installed directly onto -- `F.prototype.n =
   * function () {...}` (or the element-access spelling, `F.prototype['n'] =
   * ...`) -- or `null` when it is not installed that way.
   *
   * ECMA-262 10.2.5 MakeConstructor gives every ordinary function a real,
   * mutable "prototype" object, and `new F()`'s instance has that object as
   * its `[[Prototype]]` (10.2.2 OrdinaryCreateFromConstructor) -- so a
   * function reached by walking that chain (`g.get()` for
   * `G.prototype.get = function () { return this.v }`) is entered with the
   * INSTANCE as `this`, not with `G.prototype` itself. Distinct from
   * `installedThisMethodHostOf`'s `this.X = function(){}` pattern: that one
   * runs INSIDE an enclosing function whose own receiver is what the
   * assignment writes onto, while this is a plain top-level statement naming
   * the constructor by its own binding, with no enclosing function to walk
   * out to and no `this` anywhere in the assignment's own target.
   */
  const prototypeMethodConstructorOf = (declaration: ts.FunctionExpression | ts.FunctionDeclaration): ts.Type | null => {
    const assignment = declaration.parent
    if (!ts.isBinaryExpression(assignment) || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null
    if (assignment.right !== declaration) return null
    const target = assignment.left
    if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return null
    const prototypeAccess = target.expression
    if (!ts.isPropertyAccessExpression(prototypeAccess) || prototypeAccess.name.text !== 'prototype') return null
    return checker.getTypeAtLocation(prototypeAccess.expression)
  }

  /**
   * The receiver an ordinary JavaScript function is entered with, for the one
   * shape where the language supplies one the type system never spells: the
   * pre-`class` constructor function three.js's renderer is built out of.
   *
   * `function WebGLClipping( properties ) { this.uniform = uniform; ... }`,
   * invoked as `new WebGLClipping(...)`. TypeScript's own JS inference already
   * gives such a function BOTH a call signature and exactly one construct
   * signature, and gives the construct signature's return type ("Constructed")
   * the property set those `this.x = ` assignments produce -- so the receiver
   * is not derived here, it is READ from the construct signature the checker
   * already resolved. Without it the convention declares no receiver while the
   * body reads `this` from a frame slot that does not exist, and the whole
   * body is withheld: ten of them in one program (`WebGLTextures`,
   * `WebGLProgram`, `WebGLShadowMap`, `WebGLClipping`, ...), which is the
   * renderer.
   *
   * The candidate rule: exactly one construct signature and at least one
   * call signature. Zero call signatures is a real constructor (a class, or
   * `constructor-value-dispatch`), which needs none of this; more than one
   * construct signature is an overload set no single frame answers for. An
   * arrow is never a candidate -- ECMA-262 15.3 gives it no `[[Construct]]`,
   * so the checker never gives one a construct signature.
   *
   * A function INSTALLED as a method (`this.setState = function ( material )
   * { this.numPlanes += n; }`) is the case this must not read its own
   * construct signature for. TypeScript's constructor-function inference fires
   * on it too -- any function with top-level `this.x = ` writes gets a
   * construct signature, and its "Constructed" type is the subset of fields
   * IT assigns (`{ numPlanes, numIntersection }` for `setState`) -- but that
   * type is a fiction as a receiver: at runtime `this` inside it is the whole
   * instance, because the only way the program reaches it is
   * `scope.setState( material )`. Reading its own construct signature there
   * would declare a convention taking a two-field record while every call site
   * passes the instance. So the host's Constructed type answers for it, which
   * is what the call actually passes.
   */
  const jsConstructorReceiverOf = (declaration: ts.SignatureDeclaration): ts.Type | null => {
    if (!ts.isFunctionDeclaration(declaration) && !ts.isFunctionExpression(declaration)) return null
    if (!declaration.body || !bodyReadsThis(declaration.body)) return null
    const host = installedThisMethodHostOf(declaration)
    if (host !== null) return jsConstructorReceiverOf(host)
    // A `function` expression stored as an object literal's PROPERTY
    // (`{ m: function () { return this } }`) is the literal's method spelled
    // the ES5 way: `o.m()` binds `this` to the literal, and the checker types
    // the keyword in the body as the literal. Only the spelling differs from
    // `implicitReceiverOf`'s `MethodDeclaration` branch, so it takes the same
    // receiver, behind the same `bodyReadsThis` gate (above) and for the same
    // reason: a body that never mentions `this` says nothing about the frame,
    // and granting every property-held function a receiver would walk the
    // enclosing literal for essentially every one in a real program.
    const owner =
      ts.isFunctionExpression(declaration) && ts.isPropertyAssignment(declaration.parent) && declaration.parent.initializer === declaration
        ? declaration.parent.parent
        : null
    if (owner && ts.isObjectLiteralExpression(owner)) return overriddenLiteralReceiverOf(declaration, owner) ?? layoutTypeAt(owner)
    const prototypeConstructor = prototypeMethodConstructorOf(declaration)
    if (prototypeConstructor !== null) {
      const construct = prototypeConstructor.getConstructSignatures()
      if (construct.length !== 1) return null
      const constructed = construct[0]
      return constructed ? constructed.getReturnType() : null
    }
    const type = checker.getTypeAtLocation(declaration)
    const construct = type.getConstructSignatures()
    const constructed = type.getCallSignatures().length === 0 || construct.length !== 1 ? undefined : construct[0]
    if (constructed) return constructed.getReturnType()
    return implicitAnyReceiverOf(declaration)
  }

  /**
   * The receiver of an ordinary function the language supplies and the type
   * system spells only as `any`.
   *
   * `function replacement(value) { return `${this}:${value}` }`, installed as
   * six different callables' own `call` property: every branch above answers
   * `null` for it -- there is no enclosing literal, no `this.x =` host, no
   * `F.prototype.m =` owner, and no construct signature, because the body
   * never writes a field. Its `this` is nonetheless real at runtime, and the
   * checker already says what it knows about it: `any`. Reading that answer
   * rather than inventing one keeps this the checker's fact, and keeps it
   * narrow -- a body whose `this` the checker types as anything CONCRETE is
   * a shape one of the branches above is meant to resolve, and inventing a
   * boxed receiver for it would box a value that has a static type.
   *
   * Without it the convention declares no receiver while the body reads one,
   * which lowering refuses by name; so this can only turn a refused program
   * into an emitted one.
   */
  const implicitAnyReceiverOf = (declaration: ts.FunctionDeclaration | ts.FunctionExpression): ts.Type | null => {
    if (!declaration.body) return null
    const keyword = firstOwnThisKeyword(declaration.body)
    if (keyword === null) return null
    const receiver = checker.getTypeAtLocation(keyword)
    return (receiver.flags & ts.TypeFlags.Any) === 0 ? null : receiver
  }

  /**
   * The receiver the callable type of a DECLARED member carries.
   *
   * `interface GetterCursor { readonly next: () => Step }` spells a member
   * whose type is a callable, and the two spellings `next(): Step` and
   * `readonly next: () => Step` are the same member as far as `o.next()` is
   * concerned -- ECMA-262 binds `o` as the receiver either way. So the same
   * census answers both: this member carries a receiver iff the value some
   * implementer stores into it does. Without it the implementer's
   * `function (this: GetterCursor) { ... }` derives a callable WITH a frame
   * slot while the slot it is stored into derives one without, and that store
   * is not a conversion C++ has (`typed-custom-iterator-receiver.runtime.ts`).
   *
   * Program-declared only, for the same reason the `MethodSignature` branch is:
   * a standard-library member is backed by the native intrinsic protocols,
   * which carry their receiver separately from a JavaScript callable's frame.
   */
  const declaredMemberCallableReceiverOf = (member: ts.Symbol): ts.Type | null => {
    if (!declaredMembers.implementationReadsReceiver(member)) return null
    const owner = member.declarations?.[0]?.parent
    if (!owner || !ts.isInterfaceDeclaration(owner) || owner.getSourceFile().hasNoDefaultLib) return null
    const declared = checker.getSymbolAtLocation(owner.name)
    return declared ? checker.getDeclaredTypeOfSymbol(declared) : null
  }

  /**
   * The same answer, reached from either NODE that spells one member's
   * callable type: the member's own `readonly next: () => Step`, and the
   * implementing `get next(): () => Step`'s return annotation. They are two
   * spellings of one type, so a receiver on one and none on the other is the
   * store the whole census exists to remove -- and the getter's annotation is
   * the node the `return function (this: GetterCursor) {...}` inside it is
   * actually converted to.
   */
  const declaredCallableMemberReceiverOf = (declaration: ts.FunctionTypeNode): ts.Type | null => {
    const holder = declaration.parent
    if (ts.isPropertySignature(holder)) {
      const member = checker.getSymbolAtLocation(holder.name)
      return member ? declaredMemberCallableReceiverOf(member) : null
    }
    if (!ts.isGetAccessorDeclaration(holder) || holder.type !== declaration) return null
    const member = declaredMembers.declaredMemberImplementedBy(holder.name)
    return member ? declaredMemberCallableReceiverOf(member) : null
  }

  const overriddenLiteralReceiverOf = (declaration: ts.SignatureDeclaration, literal: ts.ObjectLiteralExpression): ts.Type | null => {
    if (!('body' in declaration) || !declaration.body) return null
    const keyword = firstOwnThisKeyword(declaration.body)
    return keyword === null ? null : contextTypedLiteralThisOf(checker, literal, keyword)
  }

  const implicitReceiverOf = (declaration: ts.SignatureDeclaration): ts.Type | null => {
    if (
      !ts.isMethodDeclaration(declaration) &&
      !ts.isGetAccessorDeclaration(declaration) &&
      !ts.isSetAccessorDeclaration(declaration) &&
      !ts.isMethodSignature(declaration)
    ) {
      if (ts.isFunctionTypeNode(declaration)) return declaredCallableMemberReceiverOf(declaration)
      return jsConstructorReceiverOf(declaration)
    }
    const parent = declaration.parent
    if ((ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Static) !== 0) {
      // A receiver-free implementation must not demand conversion of a
      // derived constructor into its declaring constructor at inherited calls.
      // Include parameter initializers and lexical arrows; super calls also
      // consume the current receiver even without an explicit `this` token.
      // A declaration without a body provides no such implementation proof.
      if (!ts.isMethodSignature(declaration) && declaration.body && !bodyReadsThis(declaration, true)) return null
      // A static method still receives `this`; its value is the class
      // constructor object rather than an instance. TypeScript does not spell
      // that implicit receiver as a `thisParameter`, just as it does not spell
      // the instance receiver below. Read the owning class's value-side type so
      // the callable ABI, its call site, and a body-side `this` all carry the
      // same constructor-family value.
      if (!ts.isClassLike(parent)) return null
      // An ANONYMOUS class expression (`var C = class { static get m() {
      // return this.#x } }`) has no name node to ask a symbol of, and the
      // checker answers no symbol for the expression node itself; asking the
      // expression's own TYPE gives its value side -- the constructor type --
      // directly, which is exactly what the named path reads through the
      // symbol. (A class DECLARATION's node type is its instance type, so the
      // symbol path stays for it.)
      if (ts.isClassExpression(parent) && !parent.name) return checker.getTypeAtLocation(parent)
      const symbol = checker.getSymbolAtLocation(parent.name ?? parent)
      return symbol ? checker.getTypeOfSymbolAtLocation(symbol, parent) : null
    }
    // An object literal's own *method*. Unlike an accessor (below, still
    // unconditional -- an accessor's member type in the containing shape is
    // the property's type, not this signature, so walking the literal never
    // re-enters through it, exactly as before this patch), a method member's
    // type IS its signature, so `objectShapeOf`'s member walk calls straight
    // back into `signatureOf` for it -- and granting EVERY method a receiver
    // regardless of whether its body reads `this` reaches `typeOf` on the
    // enclosing literal for essentially every method-bearing object literal in
    // a real program. Gating on `bodyReadsThis` scopes the eager anchor
    // (`translate`'s plain-object branch, edit 6) to genuinely
    // self-referential literals only -- the blocker shape this
    // mechanism exists for -- and leaves an ordinary method-bearing literal's
    // identity, and every downstream consumer of it, completely untouched.
    if (ts.isObjectLiteralExpression(parent)) {
      const overridden = overriddenLiteralReceiverOf(declaration, parent)
      if (overridden !== null) return overridden
      if (ts.isMethodDeclaration(declaration)) {
        if (declaration.body && bodyReadsThis(declaration.body)) return layoutTypeAt(parent)
        // The body does not read `this`, so it says nothing about the frame.
        // The member this method implements does -- see
        // `declaredMemberReceiverOf` above.
        return declaredMemberReceiverOf(declaration, parent)
      }
      return layoutTypeAt(parent)
    }
    // An interface's own signature member has NO body of its own, so there is
    // no `this`-reading body to gate on the way an object literal's method is
    // gated. Granting one a receiver UNCONDITIONALLY is actively harmful, and
    // that is measured, not feared: it costs `overload-set-as-value.ts` and
    // `control-flow-structural-view.ts`, whose members no implementer reads a
    // receiver for. This file said so, and it was retried anyway.
    //
    // But answering `null` unconditionally is the same defect mirrored: it let
    // the SPELLING of a declaration decide the calling convention, so the
    // implementing literal's `next() { return this.label }` took a receiver
    // while the interface member it satisfies took none, and storing one into
    // the other is a conversion between two conventions C++ does not have
    // (`typed-custom-iterator-receiver.runtime.ts`). One member, one answer.
    //
    // The proof a `MethodSignature` lacks is held by its IMPLEMENTERS, which is
    // what `censusDeclaredMembers` supplies: this member carries a receiver iff
    // some object literal implementing it reads one. Program-declared only --
    // a standard-library member is implemented by the native intrinsic
    // protocols, which carry their receiver separately from a JavaScript
    // callable's frame, and its declaration is the open `Map<K, V>` rather than
    // the instantiated receiver at a use site.
    if (ts.isInterfaceDeclaration(parent) && ts.isMethodSignature(declaration) && !parent.getSourceFile().hasNoDefaultLib) {
      const member = checker.getSymbolAtLocation(declaration.name)
      if (member && declaredMembers.implementationReadsReceiver(member)) {
        const declared = checker.getSymbolAtLocation(parent.name)
        if (declared) return checker.getDeclaredTypeOfSymbol(declared)
      }
      return null
    }
    //
    // A type-literal's own signature member IS safe, but only when the
    // literal is the direct body of a named `type X = { ... }` alias --
    // `declaredAnchorOf` anchors THAT case eagerly (with this patch's
    // alias-priority fix, edit 5), same as an interface. A type literal
    // reached any other way -- nested inside another type (`host.ts`'s
    // ambient `declare const bluetooth: { connect(): Promise<{ device: {...}
    // }> }`-shaped host surfaces are full of these), a function's own inline
    // return-type annotation, anywhere with no enclosing alias -- has NO
    // anchor at all: `declaredAnchorOf` only resolves through
    // `type.getSymbol() ?? type.aliasSymbol`, and a type literal with no
    // enclosing alias has no `aliasSymbol` for that fallback to find.
    // Granting such a member a receiver reaches `typeOf` on a type with no
    // anchor reserved, straight into the exact `walking.has` collision this
    // whole mechanism exists to avoid -- measured directly: a version of this
    // patch that omitted the `isTypeAliasDeclaration(parent.parent)` check
    // below broke 25/116 corpus programs, ALL of them failing through dozens
    // of distinct anonymous `__type` collisions inside
    // `core/packages/core/runtime/host.ts`'s nested ambient object types (see
    // `risks.md`). Returning `null` for every other type-literal parent
    // matches this signature's ORIGINAL, pre-patch behavior exactly (this
    // whole branch did not exist before this patch), so nothing about a
    // nested/unnamed type literal's identity or receiver treatment changes.
    if (ts.isTypeLiteralNode(parent) && parent.parent && ts.isTypeAliasDeclaration(parent.parent)) {
      // STATED, and not an expression to begin with: `parent` is a
      // `TypeLiteralNode` syntax node -- the receiver this returns is the
      // named TYPE ALIAS's own declared shape, used purely as a nominal
      // identity anchor (see the surrounding comment on why an anchor is
      // needed here at all). No value flows through this node for a
      // parameter/write-set census to have evidence about.
      return checker.getTypeAtLocation(parent)
    }
    if (ts.isTypeLiteralNode(parent)) {
      return null
    }
    if (!ts.isClassLike(parent)) return null
    if (ts.isClassExpression(parent) && !parent.name) {
      // Same anonymous-expression gap as the static branch above: the instance
      // type is what the expression's constructor type constructs.
      const construct = checker.getTypeAtLocation(parent).getConstructSignatures()[0]
      return construct ? construct.getReturnType() : null
    }
    const symbol = checker.getSymbolAtLocation(parent.name ?? parent)
    return symbol ? checker.getDeclaredTypeOfSymbol(symbol) : null
  }
  return { implicitReceiverOf, declaredMemberSignatureOf }
}

// Whether a signature's own declaration carries the `async` modifier.
// Mirrors `implicitReceiverOf`'s `getCombinedModifierFlags` check
// immediately above, rather than re-deriving the answer a different way.
// `semantics/normalize/producers/invocations.ts` duplicates this same
// two-line check independently (a call's own resolved-signature return
// type, and the call expression's own published result, both need the
// identical answer) -- see citations.md finding 2 for why it is duplicated
// rather than shared across the two files.
export const isAsyncSignature = (declaration: ts.SignatureDeclaration | undefined): boolean =>
  declaration !== undefined && (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Async) !== 0
