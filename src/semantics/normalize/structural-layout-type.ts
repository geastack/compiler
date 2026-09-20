import {
  annotationStatesNothing,
  censusedTypeAt,
  containsUnstatedPosition,
  narrowsOnlyUnstatedPositions,
  singleConventionAt,
  impliedPatternElementRootOf,
  impliedPatternParameterOf,
  impliedPatternTargetOf,
  objectAssignFreshTargetType,
  nominalConstructorChoiceTypeAt
} from './derived-expression-type.js'
import { isUnreducedTypeForm } from './unreduced-type-form.js'
import ts from 'typescript'
import { emptyAbsentGlobalCensus, type AbsentGlobalCensus } from './absent-globals.js'
import { emptyParameterBindingCensus, type ParameterBindingCensus } from './parameter-bindings.js'

/**
 * Which type an object or array literal is laid out as.
 *
 * Split out of `structural.ts` -- it closes over nothing but the checker, and
 * that file's own subject is the walk that interns a type, not the question of
 * which type to walk.
 */
export const createLayoutTypeResolver = (
  checker: ts.TypeChecker,
  parameters: ParameterBindingCensus = emptyParameterBindingCensus,
  absent: AbsentGlobalCensus = emptyAbsentGlobalCensus
): ((node: ts.Node) => ts.Type) => {
  /**
   * An array-pattern element read past the end of a plain array binds
   * `undefined`, and the checker's own type for the name omits it: `var [a,
   * b, c] = xs` over a `number[]` types `c` as `number` (the same unsound
   * index read `noUncheckedIndexedAccess` exists to correct). The pattern
   * census reads the position WITH its absence (`patternReadTypeAt`, tuple
   * holders excepted, since a tuple states its length), and where the two
   * disagree the census is the one that can be true: laying `c` out as a bare
   * number made its initialization dereference an empty optional, and the
   * program printed `0` where the language answers `undefined`.
   *
   * A defaulted element is left alone -- the name is bound to the joined
   * type once the default has run, which is what the checker answers.
   */
  const arrayPatternReadOutranking = (node: ts.Node, own: ts.Type): ts.Type | null => {
    // An `any` here is the census's own gate below, and the census already
    // reads the element with its absence; answering first would hand it the
    // checker's nothing widened by `undefined`, which is still nothing.
    if ((own.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 || containsUndefined(own)) return null
    const element = ts.isBindingElement(node) ? node : ts.isIdentifier(node) ? arrayPatternElementDeclaring(node) : null
    // An OBJECT pattern's numeric key over an array is the same read spelled
    // differently (`[...{ 3: y }] = [7, 8, 9]`), and the census publishes it
    // through the same channel; the `containsUndefined(read)` test below is
    // what keeps every ordinary member read out of this rule.
    if (!element || element.initializer || element.dotDotDotToken) return null
    const read = parameters.patternReadTypeAt?.(element) ?? null
    if (!read || !containsUndefined(read)) return null
    // A reference keeps whatever the checker narrowed the payload to at that
    // site and regains only the absence the declaration lost: the checker
    // narrowed from the unsound `number`, so a guard it credited cannot be
    // told from no guard at all, and the absence has to stay in the carrier
    // until a test the program actually wrote removes it.
    return ts.isBindingElement(node) ? read : checker.getNullableType(own, ts.TypeFlags.Undefined)
  }
  const arrayPatternElementDeclaring = (node: ts.Identifier): ts.BindingElement | null => {
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration
    return declaration && ts.isBindingElement(declaration) ? declaration : null
  }
  const containsUndefined = (type: ts.Type): boolean =>
    (type.flags & ts.TypeFlags.Undefined) !== 0 || (type.isUnion() && type.types.some((arm) => (arm.flags & ts.TypeFlags.Undefined) !== 0))

  /** The single arm of a union that could have been written as a literal, or nothing when the choice is genuinely ambiguous. */
  const soleShapedArm = (union: ts.UnionType): ts.Type | null => {
    const shaped = union.types.filter((member) => (member.flags & ts.TypeFlags.Object) !== 0)
    return shaped.length === 1 ? (shaped[0] ?? null) : null
  }

  /**
   * The property names every object already carries, declared shape or not --
   * resolved from the checker's own global `Object` type rather than
   * hardcoded, so it tracks whatever lib version this program actually
   * compiles against.
   *
   * Memoized once: `Object`'s own members do not vary by call site, and
   * `resolveName` walks scope from whatever node is handed to it, which is
   * wasted work to repeat per literal.
   */
  let objectBaselineMembers: ReadonlySet<string> | null = null
  const objectBaselineMembersOf = (node: ts.Node): ReadonlySet<string> => {
    if (objectBaselineMembers) return objectBaselineMembers
    const symbol = checker.resolveName('Object', node, ts.SymbolFlags.Type, false)
    const baseline = symbol ? checker.getDeclaredTypeOfSymbol(symbol).getProperties() : []
    objectBaselineMembers = new Set(baseline.map((property) => property.getName()))
    return objectBaselineMembers
  }

  /**
   * Whether a contextual candidate adds nothing beyond what `Object` itself
   * already carries -- the JSDoc `{Object}` escape hatch (`Object` is
   * assignable from any non-nullish value, precisely because it declares
   * nothing) and its structural twin, the anonymous `{}`/top type, whose own
   * property list is empty for the identical reason.
   *
   * Both are `TypeFlags.Object` and both pass every check above, but neither
   * is "the declared shape a literal was checked against" the way `Point` or
   * `CameraCaptureOptions` is: substituting one in throws the literal's own
   * real fields away for a handful of methods (or nothing) every value
   * already has. `three/src/core/EventDispatcher.js`'s own `@param {Object}
   * event` is the concrete case -- `{ type, handedness, target }` contextually
   * types as `Object`, and adopting that as the layout produced a record
   * whose only fields were `Object.prototype`'s, with `handedness` nowhere
   * in it. A type that genuinely adds members (`EventInit`, also declared in
   * a lib file) does not match this test, because its own properties are not
   * a subset of the baseline.
   */
  const isVacuousObjectType = (node: ts.Node, type: ts.Type): boolean => {
    // An INDEX SIGNATURE is a declared shape, and it declares no named members
    // at all -- so a test that reads only `getProperties()` calls
    // `Record<string, string>` vacuous for exactly the reason it is not.
    // `voice-notes` proved it: `{ Authorization, 'Content-Type' }` written into
    // a `Record<string, string> | undefined` header field stopped adopting the
    // dictionary and minted its own struct, and `Optional<Ref<Dictionary<...>>>
    // = gea_record_type_974` has no viable assignment. One value, two layouts,
    // and no conversion between them -- which is the very thing the contextual
    // rule above exists to prevent.
    if (checker.getIndexInfosOfType(type).length > 0) return false
    const baseline = objectBaselineMembersOf(node)
    return type.getProperties().every((property) => baseline.has(property.getName()))
  }

  /**
   * Whether a type is TypeScript's own evolving-array placeholder: an array
   * whose element the checker has not finalized yet at this location.
   *
   * `let arr = []` is `any[]` at its own declaration, and at every mutating
   * reference reachable from it, because ECMA-262 says nothing about the
   * elements an empty array literal will ever hold and the checker widens the
   * element type across every `push`/index write it can still see ahead of
   * that point. It only settles a first-class element type -- `number[]`,
   * `BufferAttribute[]` -- once flow analysis knows no more assignments
   * follow, typically where the array escapes (a `return`, an argument, a
   * property write). Treating the placeholder as the cell's PHYSICAL storage
   * type is a defect in this compiler, not a fact about the program: the
   * checker HAS the finalized element type, this call is simply asking for
   * it at the one location -- the declaration, or an intermediate mutation --
   * where the checker has not computed it yet.
   */
  const isEvolvingArrayType = (type: ts.Type): boolean => {
    if (!checker.isArrayType(type)) return false
    const [element] = checker.getTypeArguments(type as ts.TypeReference)
    return element !== undefined && (element.flags & ts.TypeFlags.Any) !== 0
  }

  /**
   * The declaration symbol a node's checker type should be asked on behalf
   * of, when that node is not itself the read of a binding.
   *
   * An identifier reference already names its own symbol. A `let`/`const`
   * declaration's name does too, one level down. An array literal is neither
   * -- it is the RHS of exactly one declaration when it initializes one
   * (`let arr = []`), and that declaration's symbol is the one whose whole
   * lifetime this literal's placeholder needs to be resolved against, not the
   * literal's own (symbol-less) identity.
   */
  const boundSymbolOf = (node: ts.Node): ts.Symbol | null => {
    if (ts.isIdentifier(node)) return checker.getSymbolAtLocation(node) ?? null
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return checker.getSymbolAtLocation(node.name) ?? null
    const parent = node.parent
    if (parent && ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
      return checker.getSymbolAtLocation(parent.name) ?? null
    }
    return null
  }

  /**
   * The last reachable reference to a symbol in the file that declares it.
   *
   * Only a real reference -- an `Identifier` the checker can resolve back to
   * this exact symbol -- makes the checker compute a flow-narrowed answer at
   * all: asking at an unrelated later node (a sibling statement, the
   * function's closing brace) reports the identical unsettled placeholder the
   * declaration does, verified directly against the checker. Comparing by
   * the RESOLVED symbol rather than the name's text is what keeps a
   * same-spelled binding in a nested, shadowing scope from ever being
   * mistaken for a reference to this one -- two identifiers spelled alike
   * resolve to two different symbols, and only a match on the resolved
   * symbol is admitted. Lexical scoping already guarantees every real
   * reference to a local symbol lives in the file that declares it, so
   * walking that whole file, rather than hunting for the nearest enclosing
   * function, costs nothing in correctness.
   */
  const lastReferenceTo = (symbol: ts.Symbol, file: ts.SourceFile): ts.Node | null => {
    let last: ts.Node | null = null
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
        if (!last || node.getStart() > last.getStart()) last = node
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    return last
  }

  // Memoized per symbol: every mutation site and the declaration itself ask
  // this question about the SAME binding, and finding its last reference
  // walks the whole declaring file, so paying that cost once per symbol
  // rather than once per reference is what keeps a file with many evolving
  // arrays from re-walking itself once per `push` call.
  const settledEvolvingType = new Map<ts.Symbol, ts.Type | null>()

  /**
   * `own`, unless it is an evolving-array placeholder this call can settle.
   *
   * Settling means resolving the SAME symbol's checker type at its last
   * reachable reference instead -- exactly the technique that already
   * distinguishes an intermediate `arr.push(x)` (still placeholder, nothing
   * to substitute) from the escaping use that finalized it. Substituting only
   * when the alternative is ITSELF no longer a placeholder is what keeps
   * this idempotent and total: a binding that never finishes evolving within
   * the visible program keeps its honest, still-placeholder answer, the same
   * one every reference to it already agreed on.
   */
  const settleEvolving = (node: ts.Node, own: ts.Type): ts.Type => {
    if (!isEvolvingArrayType(own)) return own
    const symbol = boundSymbolOf(node)
    if (!symbol) return own
    let settled = settledEvolvingType.get(symbol)
    if (settled === undefined) {
      const last = lastReferenceTo(symbol, node.getSourceFile())
      // HOLDS, not stated: what does this reference actually evaluate to.
      // Asking the shared authority rather than the checker directly lets a
      // census answer settle the reference the identical way it would settle
      // any other read of this symbol -- the census has no reason to answer
      // differently at the last reference than it would anywhere else this
      // binding is read.
      const candidate = last ? censusedTypeAt(checker, parameters, last) : null
      settled = candidate && !isEvolvingArrayType(candidate) ? candidate : null
      settledEvolvingType.set(symbol, settled)
    }
    return settled ?? own
  }

  /**
   * The type an expression's value physically is.
   *
   * For an object or array literal this is its *contextual* type when the
   * language gives it one: `const p: Point = { x: 0, y: 1 }` has one value, and
   * letting the literal keep its own fresh anonymous type would give that value
   * two structural identities, two C++ layouts, and a conversion between them
   * that describes nothing real. TypeScript's fresh literal type exists for
   * excess-property checking, not for layout.
   *
   * A union contextual type contributes its arm only when exactly ONE arm has
   * a layout at all. `capture(options?: CameraCaptureOptions)` gives the
   * literal a contextual type of `CameraCaptureOptions | undefined`, and
   * `undefined` is not a shape a literal could have been written as -- there is
   * one candidate, so choosing it is reading the program, not guessing at it.
   * Refusing the whole union instead left `Camera.capture({ mirror: true })`
   * allocating a fresh anonymous `record(mirror: boolean)` and handing it to a
   * slot carrying `optional(native-record-ref(CameraCaptureOptions),
   * undefined)`: two layouts for one value, and no conversion between them
   * because there is no real conversion to write.
   *
   * Two or more object arms stay refused, unchanged: that is a genuine decision
   * about which shape was meant, and picking one would silently give the value
   * a layout the program never asked for. An intersection stays refused for the
   * same reason.
   *
   * An array literal narrows the whole rule further: it accepts a candidate
   * only when that type is *itself* array- or tuple-shaped. The "one value,
   * one identity" argument above only holds when the contextual type describes
   * the same physical thing the literal's own type already does -- true of a
   * tuple assigned by position (`readonly [number, number]`, whose own
   * inferred type is already the identical tuple), false of an arbitrary
   * Object-flagged interface an overloaded call's parameter happens to name
   * (`new Uint8Array([68, 73, 65, 71])` contextually types the argument
   * against `Iterable<number>`, a symbol-keyed protocol with no data layout at
   * all). Substituting that in would hand a 4-element literal a 0-field struct
   * to write into -- not a gap this compiler has not built yet, but a layout
   * that was never this value's shape to begin with. `checker.isArrayType`/
   * `isTupleType` is the same pair `typeOf` above already dispatches an array
   * literal's own (uncontextualized) type through, so an array literal that
   * keeps `own` here still normalizes exactly the way it always did.
   */
  /**
   * The type of a property/element access whose RECEIVER a census bound but the
   * checker did not, or `null` when that does not apply.
   *
   * Refuses whenever the answer would be `any` again, so this can only ever
   * replace a box with a real carrier -- never widen one thing into another.
   */
  /** An element access's key when the program wrote it down literally, else `null`. */
  const literalKeyOf = (node: ts.ElementAccessExpression | ts.PropertyAccessExpression): string | null => {
    if (!ts.isElementAccessExpression(node)) return null
    const argument = node.argumentExpression
    if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return argument.text
    if (ts.isNumericLiteral(argument)) return argument.text
    return null
  }

  /**
   * The member of a union receiver only ONE arm declares.
   *
   * `getPropertyOfType` answers for a union only when EVERY arm declares the
   * key, which is the right rule for a type the program must be able to use
   * without knowing which arm it holds. It is not the only readable case.
   * three's `Matrix4.makeTranslation( x, y, z )` takes `{number|Vector3} x` and
   * reads `x.x`, `x.y`, `x.z` after its own `if ( x.isVector3 )` brand check --
   * a check TypeScript cannot narrow on, because `isVector3` is not declared on
   * `number` either, so `x` stays the union and all three reads come back `any`
   * with no symbol. Ten of the prototype's unmet obligations are those reads.
   *
   * ECMA-262 10.1.8 says what the other arms answer: `[[Get]]` walks the
   * prototype chain, finds no property, and returns `undefined` at step 3 --
   * it does not throw. So the honest type of such a read is the owning arm's
   * member type OR `undefined`, and that is what this returns. Nothing here
   * assumes the guard: the tagged-union emitter already dispatches on the arm
   * tag and renders `undefined` for an arm without the key
   * (`emit-union-properties.ts`'s `taggedUnionGetText`), so the emitted read is
   * correct on every arm, not only the branded one.
   *
   * Refused when any arm is `any`/`unknown` -- such an arm declares every key
   * and no key, so "exactly one owner" would be counting an answer nobody gave.
   */
  const memberThroughSingleUnionArm = (receiver: ts.Type, key: string, node: ts.Node): ts.Type | null => {
    if (!receiver.isUnion()) return null
    if (receiver.types.some((arm) => (arm.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)) return null
    const owners = receiver.types.filter((arm) => checker.getPropertyOfType(arm, key) !== undefined)
    const only = owners.length === 1 ? owners[0] : undefined
    if (!only) return null
    const member = checker.getPropertyOfType(only, key)
    if (!member) return null
    const resolved = checker.getTypeOfSymbolAtLocation(member, node)
    if ((resolved.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return null
    return checker.getNullableType(resolved, ts.TypeFlags.Undefined)
  }

  /**
   * Whether a property/element access chain bottoms out at a parameter whose
   * STATED annotation the census narrowed -- see `statedTypeAt`
   * (`parameter-bindings.ts`). The gate on following a member read through
   * that narrowing, and deliberately not a general "follow every member read
   * through the census" rule: this file's own header records what happened
   * the last time this resolver answered ahead of the checker for nodes other
   * producers derive independently.
   */
  const receiverChainWasNarrowedByStatement = (node: ts.Node): boolean => {
    let current: ts.Node = node
    for (let depth = 0; depth < 8; depth += 1) {
      if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) return false
      const receiver = current.expression
      if (parameters.statedTypeAt(receiver)) return true
      current = receiver
    }
    return false
  }

  /**
   * A member symbol's type, asked again from the CLASS FIELD CENSUS -- and,
   * failing that, again of the checker at the member's own declaration --
   * when the checker's answer for the actual READ location is `any`/`unknown`.
   *
   * Measured on the three.js app: `renderer.shadowMap` off the IDENTICAL receiver
   * carrier (`class-ref` for `WebGLRenderer`, proven by
   * `_this.shadowMap = shadowMap` at `WebGLRenderer.js:516`) answers
   * `native-record-ref` when read from the app's entry module and `dynamic` when
   * read from `WebGLPrograms.js:439` -- the same `getPropertyOfType` +
   * `getTypeOfSymbolAtLocation` pair, on the same property symbol,
   * disagreeing only by which node is handed to `getTypeOfSymbolAtLocation`
   * as `at`. `shadowMap` is a `this`-property whose type TypeScript derives
   * by control-flow analysis of its assignment(s) inside `WebGLRenderer`'s
   * own constructor; asking for that type "at" a node with no flow edge to
   * the assignment is not guaranteed to reach the same settled answer a
   * read from at or near the declaring scope gets.
   *
   * `structural-parts.ts`'s `memberOf` already has the fix for the
   * IDENTICAL split on the field's STORAGE side (what the class layout
   * holds): past its own `isUnusableEvidence` gate, it asks `parameters` --
   * "the fully composed parameter+return+local+field census, despite the
   * name" -- at the member's declaration, because `field-bindings.ts`
   * "already joins every write reaching the FIELD's symbol under one
   * answer". This function is the READ side of the same field, in a
   * different file, and it had no equivalent fallback at all -- it asked
   * the checker once, at the read site, and gave up. `parameters` is the
   * same composed census both files close over, so this asks it the exact
   * same way `memberOf` does, at the exact same node.
   *
   * The plain re-ask of the checker at the declaration is kept as a second,
   * narrower fallback for a member the field census does not cover (an
   * ordinary TypeScript field or interface member, which the checker alone
   * can still answer correctly from its own declaration even where the read
   * site could not) -- gated to a receiver that is NOT a generic
   * instantiation, since a generic class's member type read at its bare
   * declaration is open in the class's own type parameters, unsubstituted
   * for this particular receiver, and publishing that would be a
   * different, wider defect than the one this exists to fix. The census
   * fallback carries no such risk: it answers what a WRITE'S OWN VALUE
   * resolved to, not a re-derivation of the member's declared type, so it
   * is asked unconditionally.
   *
   * Purely additive throughout -- every fallback here only replaces a
   * `null` `memberThroughBoundReceiver` was already about to return (the
   * checker had nothing usable at the read site), so a program where the
   * read-site answer was already usable is untouched, and a field that is
   * genuinely dynamic even to the census and at its own declaration still
   * answers `null` here exactly as before -- the negative control this
   * fix's own test asserts.
   */
  const declaredMemberTypeOf = (property: ts.Symbol, receiver: ts.Type, node: ts.Node): ts.Type | null => {
    const atReadSite = checker.getTypeOfSymbolAtLocation(property, node)
    if ((atReadSite.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) return atReadSite
    const declaration = property.valueDeclaration ?? property.declarations?.[0]
    if (!declaration) return null
    // An object-literal property's own census answer is published against
    // its INITIALIZER/shorthand name, exactly as `structural-parts.ts`'s
    // `censusValueNodeOf` reads it -- a class field's is published against
    // the declaration (one of its own writes) directly.
    const censusNode = ts.isPropertyAssignment(declaration)
      ? declaration.initializer
      : ts.isShorthandPropertyAssignment(declaration)
        ? declaration.name
        : declaration
    const fromCensus = parameters.typeAt(censusNode)
    if (fromCensus && !isUnreducedTypeForm(fromCensus) && (fromCensus.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0)
      return fromCensus
    const objectFlags = (receiver as ts.ObjectType).objectFlags ?? 0
    const isGenericInstantiation = (objectFlags & ts.ObjectFlags.Reference) !== 0 && (receiver as ts.TypeReference).target !== receiver
    if (isGenericInstantiation) return null
    const atDeclaration = checker.getTypeOfSymbolAtLocation(property, declaration)
    return (atDeclaration.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0 ? atDeclaration : null
  }

  const memberThroughBoundReceiver = (node: ts.Node): ts.Type | null => {
    const isProperty = ts.isPropertyAccessExpression(node)
    // An ELEMENT access is the same read with the key written differently, and
    // it has to follow the receiver for the identical reason: `v[ i ]`,
    // `units[ i ]` and `this[ key ]` are 749 of the three.js app's boxed nodes. A
    // string-literal key is a named member and resolves exactly as `.name`
    // does; any other key resolves through the receiver's INDEX signature,
    // which is the only thing that can answer a key not known until runtime.
    if (!isProperty && !ts.isElementAccessExpression(node)) return null
    const receiver = checker.getNonNullableType(layoutTypeAt(node.expression))
    if ((receiver.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return null
    const key = isProperty ? node.name.text : literalKeyOf(node)
    if (key === null) {
      const argument = ts.isElementAccessExpression(node) ? node.argumentExpression : undefined
      if (!argument) return null
      const argumentType = layoutTypeAt(argument)
      const numeric = (argumentType.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) !== 0
      const indexed = checker.getIndexTypeOfType(receiver, numeric ? ts.IndexKind.Number : ts.IndexKind.String)
      if (!indexed) return null
      return (indexed.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ? null : indexed
    }
    const property = checker.getPropertyOfType(receiver, key)
    if (!property) return memberThroughSingleUnionArm(receiver, key, node)
    // STATED, deliberately: `property` is a member SYMBOL of `receiver`,
    // which this whole function exists to resolve past the census/checker
    // split above -- the receiver is already the best answer available (the
    // census's, when it had one). Asking the DECLARED type of a member the
    // receiver's own shape names is the correct, and only, question here;
    // there is no expression node this member read could hand to a second
    // census lookup that would not just be re-deriving `receiver` itself.
    // `declaredMemberTypeOf` is that same question asked TWICE at most --
    // once at this read site, and once at the property's own declaration
    // when the read site came back with nothing -- see its header.
    const resolved = declaredMemberTypeOf(property, receiver, node)
    if (!resolved) return null
    // An overload set has no single calling convention -- the shared rule in
    // `derived-expression-type.ts` asks the CALL which one this site selected.
    return singleConventionAt(checker, resolved, node)
  }

  /**
   * A LITERAL TOKEN'S TYPE IS THE VALUE IT SPELLS. IT IS NOT A QUESTION ABOUT
   * WHERE THE TOKEN SITS.
   *
   * `getTypeAtLocation` answers a *positional* question: it types a node as an
   * expression only when the node's parent is one of the parent kinds it
   * enumerates as putting a literal in expression position. That enumeration is
   * incomplete for the three literal kinds that are lexical TOKENS rather than
   * expression nodes -- `StringLiteral`, `NumericLiteral` and
   * `NoSubstitutionTemplateLiteral` -- and when the parent is not on the list
   * the checker declines and hands back the error type, which reads as `any`.
   *
   * `export default <literal>` is one such position, and it is not a rare one:
   * measured on the three.js app, 110 modules are exactly `export default \`...\``, a
   * plain string with no substitutions in it, and every one of them boxed. The
   * same decline is reproducible in five lines of ordinary TypeScript --
   * `export default "hello"` and `export default 42` both answer `any`, while
   * `export default true` (a keyword, not a literal token) and `export default
   * \`a${1}b\`` (a `TemplateExpression`, an expression node) both answer
   * correctly. Nothing about it is specific to any library or any host.
   *
   * So this is not a second guess at a value the program left open, the way the
   * parameter census below is: a literal token can never *genuinely* be `any`,
   * because the token states its own value. Asked before every other question
   * for that reason. The `any` guard at the call site keeps it to the case
   * where the checker declined -- wherever the checker does answer, its answer
   * (including a widened or contextually-narrowed one) still wins.
   *
   * Positions where a literal token is deliberately not a value at all -- a
   * module specifier, a literal type node, a declared property name -- are
   * excluded rather than answered, so this only ever fills in a value the
   * program really does evaluate.
   */
  const literalTokenType = (node: ts.Node): ts.Type | null => {
    const parent = node.parent as ts.Node | undefined
    if (parent) {
      if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isModuleDeclaration(parent)) return null
      if (ts.isLiteralTypeNode(parent) || ts.isImportTypeNode(parent) || ts.isExternalModuleReference(parent)) return null
      if (ts.isImportAttribute(parent) || ts.isJsxNamespacedName(parent)) return null
      if (
        (ts.isPropertyDeclaration(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isPropertyAssignment(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isMethodSignature(parent) ||
          ts.isEnumMember(parent) ||
          ts.isParameter(parent) ||
          ts.isVariableDeclaration(parent)) &&
        parent.name === node
      )
        return null
    }
    if (ts.isStringLiteral(node) || node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral)
      return checker.getStringLiteralType((node as ts.StringLiteralLike).text)
    if (ts.isNumericLiteral(node)) {
      const value = Number(node.text)
      return Number.isNaN(value) ? null : checker.getNumberLiteralType(value)
    }
    if (ts.isBigIntLiteral(node)) {
      const text = node.text.replace(/n$/, '')
      const negative = text.startsWith('-')
      return checker.getBigIntLiteralType({ negative, base10Value: negative ? text.slice(1) : text })
    }
    return null
  }

  /** `type`'s own generic target -- `Promise` for `Promise<Response>` -- or `null` when `type` is not an instantiation of one. */
  const genericTargetOf = (type: ts.Type): ts.Type | null => {
    if ((type.flags & ts.TypeFlags.Object) === 0) return null
    if (((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) === 0) return null
    return (type as ts.TypeReference).target
  }

  /**
   * The declared union arm CFA narrowing lost, when narrowing itself is the
   * defect rather than the value.
   *
   * `res instanceof Promise` on a `res` the checker can only call `any` before
   * the guard (hono's `let res: ReturnType<H>`, `H` a type parameter the
   * checker cannot resolve at this call) narrows to `Promise<any>`, not
   * `Promise<Response>` -- TypeScript's own `instanceof` narrowing against a
   * *generic* ambient class has no union arm to match against when the
   * pre-narrow type carries no type argument of its own to preserve, so it
   * fills the class's own type parameter with `any` rather than inventing one.
   * That loses information the checker already had: `res`'s DECLARED type,
   * resolved the identical way this whole resolver resolves `any` elsewhere
   * (the census composed in `parameters`, reached by asking `layoutTypeAt`
   * at the declaration's own name), is the real `Response |
   * Promise<Response>` -- and `Promise<Response>` is not a guess, it is the
   * one arm of that union built from the SAME generic target the narrowed
   * type names, so recovering it is reading a fact the checker already
   * proved, never bridging a genuinely dynamic value into a typed one.
   *
   * Gated strictly to when the narrowed type's OWN type argument is `any`:
   * a real narrowing to a concrete instantiation (`x instanceof MySubclass`
   * where `MySubclass` fixes its own type argument) never reaches this,
   * because there is nothing lost for it to recover.
   */
  const declaredGenericArmAt = (node: ts.Node, narrowed: ts.Type): ts.Type | null => {
    const target = genericTargetOf(narrowed)
    if (!target) return null
    const lostArgument = checker
      .getTypeArguments(narrowed as ts.TypeReference)
      .some((argument) => (argument.flags & ts.TypeFlags.Any) !== 0)
    if (!lostArgument) return null
    if (!ts.isIdentifier(node)) return null
    const symbol = checker.getSymbolAtLocation(node)
    const declaration = symbol?.valueDeclaration
    if (!declaration) return null
    const declaredAt = ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) ? declaration.name : declaration
    if (declaredAt === node) return null
    const declared = layoutTypeAt(declaredAt)
    // A real UNION only: a declaration with no union at all offers nothing
    // narrowing could have lost -- `declared` would just be `own` reached
    // through a different node, and treating that trivial self-match as a
    // "recovered arm" changes nothing about a real narrowing while still
    // paying a recursive lookup, and measurably churned an UNRELATED
    // rest-parameter tuple's own derivation once tried ungated. Requiring a
    // union is what keeps this to the one shape it exists for: an arm CFA
    // narrowing actually discarded.
    if (!declared.isUnion()) return null
    const matches = declared.types.filter((arm) => genericTargetOf(arm) === target)
    return matches.length === 1 ? (matches[0] ?? null) : null
  }

  /**
   * The type an EMPTY array literal fills, read off the enclosing literal's
   * own resolved layout rather than off the empty literal's own inference.
   *
   * Narrow by construction: only an array literal with no elements at all,
   * only when its own inferred element is the `never` that says nothing, and
   * only inside another array literal. Everything else keeps the contextual
   * resolution below, which is both more general and already measured. The
   * recursion into `layoutTypeAt` is what makes a chain compose, and it
   * terminates because it always moves strictly outward through the AST.
   */
  const emptyArrayPositionTypeOf = (node: ts.Node): ts.Type | null => {
    if (!ts.isArrayLiteralExpression(node) || node.elements.length > 0) return null
    const own = checker.getTypeAtLocation(node)
    if (!checker.isArrayType(own)) return null
    const [ownElement] = checker.getTypeArguments(own as ts.TypeReference)
    if (!ownElement || (ownElement.flags & ts.TypeFlags.Never) === 0) return null
    const parent = node.parent
    if (!ts.isArrayLiteralExpression(parent)) return null
    const index = parent.elements.indexOf(node)
    if (index < 0) return null
    const outer = layoutTypeAt(parent)
    if (checker.isTupleType(outer)) return checker.getTypeArguments(outer as ts.TypeReference)[index] ?? null
    if (checker.isArrayType(outer)) return checker.getTypeArguments(outer as ts.TypeReference)[0] ?? null
    return null
  }

  /**
   * The one array carrier a spread-only conditional requires when one arm is
   * syntactically empty: `...(condition ? [value] : [])`.
   *
   * The empty arm contributes no element that could disagree with the other
   * arm, and the conditional is consumed immediately as an iterable, so both
   * allocations can use the populated arm's array type. Keeping the check on
   * the enclosing SpreadElement matters: a conditional stored for later can
   * retain its union identity and be narrowed or mutated as either arm, while
   * this value has no operation between selection and iteration.
   */
  const spreadConditionalArrayTypeOf = (node: ts.Node): ts.Type | null => {
    const conditional = ts.isConditionalExpression(node)
      ? node
      : ts.isArrayLiteralExpression(node) && ts.isConditionalExpression(node.parent)
        ? node.parent
        : null
    if (!conditional) return null
    let consumed: ts.Expression = conditional
    while (ts.isParenthesizedExpression(consumed.parent) && consumed.parent.expression === consumed) consumed = consumed.parent
    if (!ts.isSpreadElement(consumed.parent) || consumed.parent.expression !== consumed) return null
    const trueEmpty = ts.isArrayLiteralExpression(conditional.whenTrue) && conditional.whenTrue.elements.length === 0
    const falseEmpty = ts.isArrayLiteralExpression(conditional.whenFalse) && conditional.whenFalse.elements.length === 0
    if (trueEmpty === falseEmpty) return null
    if (ts.isArrayLiteralExpression(node) && node.elements.length !== 0) return null
    const populated = trueEmpty ? conditional.whenFalse : conditional.whenTrue
    const type = layoutTypeAt(populated)
    return checker.isArrayType(type) ? type : null
  }

  /**
   * The declared carrier behind TypeScript's `Array.isArray` narrowing.
   *
   * The standard predicate deliberately narrows every array-shaped value to
   * `any[]`; it does not retain the element type of an array arm inside a
   * union. That is sufficient for checking JavaScript, but it is not a new
   * allocation and therefore cannot change `Material[]` into an
   * `Array<any>` physical carrier. When the binding's declared type contains
   * exactly one arm assignable to the checker's narrowed `any[]`, that arm is
   * the only carrier the predicate can have selected. Returning it preserves
   * the existing array and its element identity.
   *
   * More than one compatible arm is a real ambiguity (for example a tuple
   * beside an array) and stays with the checker. An `any[]` that was itself
   * declared as such also returns the same type, so genuinely dynamic arrays
   * remain dynamic.
   */
  const soleDeclaredArrayArm = (node: ts.Node, own: ts.Type): ts.Type | null => {
    if (!checker.isArrayType(own)) return null
    const [element] = checker.getTypeArguments(own as ts.TypeReference)
    if (!element || (element.flags & ts.TypeFlags.Any) === 0) return null

    const symbol = ts.isIdentifier(node)
      ? checker.getSymbolAtLocation(node)
      : ts.isPropertyAccessExpression(node)
        ? checker.getSymbolAtLocation(node.name)
        : undefined
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
    if (!symbol || !declaration) return null

    const declared = checker.getTypeOfSymbolAtLocation(symbol, declaration)
    // `Array.isArray(value)` narrows a value declared `any`/`unknown` to
    // `any[]`.  That is a control-flow fact about the ONE dynamic value, not
    // an allocation or an element-wise conversion.  Returning the declared
    // dynamic type keeps its `gea::Value` carrier, so the predicate's live
    // branch uses Value's recorded Array exotic hooks in place.  Deriving the
    // checker's `any[]` here would instead select `ArrayObject<Value>` and
    // force a dynamic-to-native array materialization: a differently typed
    // native array would be copied, and aliases through the original dynamic
    // value would stop observing indexed writes, deletes, and length changes.
    //
    // This is deliberately limited to a declared dynamic source AND the
    // checker's `any[]` result above.  A typed union's sole Array arm still
    // takes the arm-selection path below and remains a native array; no
    // statically typed array is routed through Value.
    if ((declared.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return declared
    const arms = declared.isUnion() ? declared.types : [declared]
    const compatible = arms.filter(
      (arm) => (arm.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0 && checker.isTypeAssignableTo(arm, own)
    )
    return compatible.length === 1 ? (compatible[0] ?? null) : null
  }

  /**
   * The dictionary a const binding aliases through a closed structural view.
   *
   * `const attrs: { position?: T; normal?: T } = geometry.morphAttributes`
   * does not allocate or copy an object. The annotation proves which named
   * reads are valid, but the value in the cell is still the initializer's
   * string-indexed dictionary. Placing the cell as the closed record would
   * require a snapshot conversion and lose both dictionary identity and later
   * mutations. Keeping the initializer carrier lets ordinary dictionary
   * property reads materialize each optional named value at its use.
   *
   * Restricted to a const variable, a source with a string index, a target
   * with named fields and no index/call/construct convention, and the
   * checker's own assignability proof. A mutable binding can later receive a
   * different implementation of the view and therefore cannot reuse this
   * argument.
   */
  const constDictionaryAliasType = (node: ts.Node, own: ts.Type): ts.Type | null => {
    const declaration = ts.isVariableDeclaration(node)
      ? node
      : ts.isIdentifier(node)
        ? checker.getSymbolAtLocation(node)?.valueDeclaration
        : undefined
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return null
    const declarationList = declaration.parent
    if (!ts.isVariableDeclarationList(declarationList) || (declarationList.flags & ts.NodeFlags.Const) === 0) return null
    if ((own.flags & ts.TypeFlags.Object) === 0) return null
    if (checker.getIndexInfosOfType(own).length > 0 || own.getProperties().length === 0) return null
    if (own.getCallSignatures().length > 0 || own.getConstructSignatures().length > 0) return null

    const physical = checker.getTypeAtLocation(declaration.initializer)
    const stringIndex = checker.getIndexInfosOfType(physical).some((index) => (index.keyType.flags & ts.TypeFlags.StringLike) !== 0)
    if (!stringIndex || !checker.isTypeAssignableTo(physical, own)) return null
    return physical
  }

  /**
   * The nominal class carrier behind a control-flow view of one member.
   *
   * After `Array.isArray(source.material)`, TypeScript can describe `source`
   * itself as an anonymous/intersection view whose `material` member is
   * narrowed. The object was not rebuilt into that record: it remains the
   * class instance bound to the parameter, while the subsequent property read
   * independently publishes the narrowed member type. Keeping the anonymous
   * receiver as a second physical layout forces a class-to-record snapshot and
   * can require an impossible `Array<T> -> Array<any>` element conversion.
   *
   * A real class or union narrowing is left intact. This only recovers a class
   * declaration when the current checker view has no class symbol of its own,
   * is not a union, and is assignable to the declared class.
   */
  const declaredClassCarrier = (node: ts.Node, own: ts.Type): ts.Type | null => {
    if (!ts.isIdentifier(node) || own.isUnion()) return null
    const symbol = checker.getSymbolAtLocation(node)
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
    if (!symbol || !declaration) return null
    const declared = checker.getTypeOfSymbolAtLocation(symbol, declaration)
    const declaredSymbol = declared.getSymbol()
    if (!declaredSymbol || (declaredSymbol.flags & ts.SymbolFlags.Class) === 0) return null
    const ownSymbol = own.getSymbol()
    if (ownSymbol && (ownSymbol.flags & ts.SymbolFlags.Class) !== 0) return null
    return checker.isTypeAssignableTo(own, declared) ? declared : null
  }

  /**
   * The dynamic carrier behind an `in`-refined structural view.
   *
   * TypeScript describes successive `"key" in value` checks over an
   * explicitly `any`/`unknown` binding as intersections such as
   * `object & Record<"key", unknown>`. Those intersections are facts about
   * which reads are now legal; they do not rebuild the runtime value into a
   * native record. Giving the view a record layout therefore changes the
   * physical carrier in the middle of one binding and makes later dynamic
   * property operations read a box as a struct.
   *
   * Preserve the declared dynamic carrier only for the checker's purely
   * structural intersection: `object` plus anonymous `Record` views. A real
   * narrowing contributes a concrete arm (`ArrayBuffer`, Array, a class, a
   * host object, and so on), whose symbol is neither the anonymous `__type`
   * nor the `Record` alias and therefore remains the layout answer.
   */
  const declaredDynamicStructuralCarrier = (node: ts.Node, own: ts.Type): ts.Type | null => {
    if (!ts.isIdentifier(node) || !own.isIntersection()) return null
    const symbol = checker.getSymbolAtLocation(node)
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
    if (!symbol || !declaration) return null
    const declared = checker.getTypeOfSymbolAtLocation(symbol, declaration)
    if ((declared.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) return null
    const structuralOnly = own.types.every((part) => {
      if ((part.flags & ts.TypeFlags.NonPrimitive) !== 0) return true
      if ((part.flags & ts.TypeFlags.Object) === 0) return false
      const alias = part.aliasSymbol?.getName()
      const name = part.getSymbol()?.getName()
      return alias === 'Record' || (alias === undefined && (name === undefined || name === '__type'))
    })
    return structuralOnly ? declared : null
  }

  const layoutTypeOf = (node: ts.Node): ts.Type => {
    // Asked FIRST, and unconditionally. A host stating that it does not provide
    // an ambient global contradicts an answer the checker is confident about --
    // `VideoFrame` types as a perfectly good constructor object -- so unlike the
    // parameter census below there is no `any` for this to fill in. The
    // declaration and every reference are answered from one table, because they
    // are one cell. See `absent-globals.ts`.
    const absentType = absent.typeAt(node)
    if (absentType) return absentType
    const constructorChoice = nominalConstructorChoiceTypeAt(checker, node, layoutTypeAt)
    if (constructorChoice) return constructorChoice
    // A narrowly scoped construction proof can outrank a checker answer that
    // is usable but wider than every value the initializer can produce. The
    // local-binding census currently publishes only the authenticated
    // `Array.isArray(slot) ? slot : [slot]` invariant through this channel.
    const preferred = parameters.preferredTypeAt?.(node)
    if (preferred) return preferred
    // A STATED ANNOTATION THAT WAS ONLY EVER AN UPPER BOUND, and the one
    // census answer this resolver takes over a checker answer it is happy
    // with. The guarded fallback below cannot serve it: the guard fires only
    // where the checker had `any` or a vacuous type, and the whole point here
    // is that the checker's answer is a perfectly good structure whose one
    // unstated leaf the program's only caller filled in concretely (hono's
    // `matchResult: Result<[unknown, RouterRoute]>`). Narrow by construction
    // -- `statedTypeAt` answers only for a parameter the census admitted
    // under `statedUpperBound` and for identifiers that read it -- and taken
    // FIRST for the reason the file's own header gives about splits: the ABI
    // slot (`structural-parts.ts`'s `parameterOf`) already reads the census,
    // so a body read answered from the checker here would be the second
    // authority, not a safer one.
    const narrowedByStatement = parameters.statedTypeAt(node)
    if (narrowedByStatement) return narrowedByStatement
    const spreadConditionalArray = spreadConditionalArrayTypeOf(node)
    if (spreadConditionalArray) return spreadConditionalArray
    // ...and the member reads THROUGH it. A narrowed parameter that nothing
    // follows is half a narrowing: `compose( middleware )` reads
    // `middleware[ i ][ 0 ]`, and the checker answers those from the
    // annotation whatever the census did to the parameter itself -- so the
    // cell held the concrete element while every read of it published the
    // stated one, which is the same two-authority split `statedTypeAt`'s own
    // doc records at the ABI. `memberThroughBoundReceiver` already resolves a
    // member off the best receiver answer available (and recurses through
    // `layoutTypeAt`, so a chain composes); this only decides WHEN to ask it,
    // and asks only where the chain bottoms out at a statement the census
    // narrowed -- never for an ordinary read, whose checker answer stands.
    if (receiverChainWasNarrowedByStatement(node)) {
      const throughStatement = memberThroughBoundReceiver(node)
      if (throughStatement) return throughStatement
    }
    // HOLDS, and yet deliberately asked of the checker FIRST, not through
    // `censusedTypeAt`. Tried census-first here and measured it directly
    // (isolated build, three.js app): boxed fell (20181->19852) but `withheld`
    // rose 6->14, all fourteen "cites result ... which no installed producer
    // publishes" -- a real disagreement, not noise. This is the ONE place in
    // the file that answers `own` for every node kind `layoutTypeAt` is ever
    // asked about, including nodes OTHER producers derive their own answer
    // for independently (an invocation's own result, a binding's own read);
    // substituting the census's answer here changes what those nodes publish
    // out from under producers that still key off the checker's own type,
    // and the two stop agreeing. The file's EXISTING design already
    // consults the census correctly for this same `own` -- conditionally,
    // a few lines down, only once `own` is `any`/vacuous (`parameters.
    // typeAt(node)` at the `bound` lookup) -- which is safe for the identical
    // reason `censusedTypeAt`'s own contract is: it only ever fires where the
    // checker had nothing. Keep asking the checker here; let the guarded
    // fallback below be the one census consultation for this value.
    const own = settleEvolving(node, checker.getTypeAtLocation(node))
    const dynamicCarrier = declaredDynamicStructuralCarrier(node, own)
    if (dynamicCarrier) return dynamicCarrier
    const classCarrier = declaredClassCarrier(node, own)
    if (classCarrier) return classCarrier
    const dictionaryAlias = constDictionaryAliasType(node, own)
    if (dictionaryAlias) return dictionaryAlias
    const declaredArrayArm = soleDeclaredArrayArm(node, own)
    if (declaredArrayArm) return declaredArrayArm
    const patternRead = arrayPatternReadOutranking(node, own)
    if (patternRead) return patternRead
    // An `any` here is one of exactly two answers worth a second question. It
    // is the only shape the checker produces that can mean "nothing was
    // written down" rather than "this is what it is, and it is dynamic" -- and
    // for a parameter the program never annotated, the call site wrote it
    // down. The census answers `null` for everything else, including a value
    // the program genuinely declared `any`, so this changes nothing about a
    // program that states its own types. See `parameter-bindings.ts`.
    //
    // The second is a type that was written down and states NOTHING --
    // `object`, `{}`, `Object`. `annotationStatesNothing` is the ONE rule that
    // decides this, shared with the two censuses (`derived-expression-type.
    // ts`); it must be asked HERE too or the two authorities split. Measured
    // exactly that: a call to `function makesBag(): object { return { a: 1, b:
    // 2 } }` had its selected signature's return type answered by the return
    // census (a real record) while this resolver, seeing a checker type that
    // is not `any`, still answered the annotation's empty record for the CALL
    // -- and `model/selected-signature.ts`'s `validateInvocationResult` fired
    // exactly as it should, taking the invocation AND the binding it
    // initialized out of the plan as withheld. The guard was right; the split
    // was here.
    // A destructured parameter's implied pattern type is the third spelling
    // of "the program stated nothing here" -- see `impliedPatternParameterOf`.
    if (
      (own.flags & ts.TypeFlags.Any) !== 0 ||
      annotationStatesNothing(checker, node, own) ||
      impliedPatternParameterOf(checker, node) !== null ||
      impliedPatternElementRootOf(checker, node) !== null
    ) {
      // Asked before the parameter census: a literal token is not a value the
      // program left open for its callers to write down. See above.
      const literal = literalTokenType(node)
      if (literal) return literal
      const bound = parameters.typeAt(node)
      // A census answer that is an OPEN FORM is not an answer -- the same rule
      // the censuses themselves apply to what they publish, asked once more
      // here because this resolver is where a census answer BECOMES a layout
      // type, and three censuses compose into the one `parameters` view. The
      // checker's own `own` (already reduced at this site) is what stands when
      // it declines. See `isUnreducedTypeForm`.
      if (bound && !isUnreducedTypeForm(bound)) return bound
      // THE CENSUS ANSWER HAS TO FOLLOW THE MEMBER READ.
      //
      // `parameters.typeAt` answers about the node a census BOUND -- a
      // parameter declaration, a cell, a field. A property access off that
      // binding is a DIFFERENT node, and the checker still answers it `any`
      // because the checker never learned what the receiver holds. So a
      // receiver the census typed perfectly well produced a boxed member read,
      // and every value derived from that read boxed in turn.
      //
      // Measured: `WebGLTextures.js`'s `_gl` parameter is bound to
      // `NativeWebGL2RenderingContext | null` -- and ALL 421 `_gl.<member>`
      // reads in that file were boxed anyway. That file carries 4435 of
      // the three.js app's 27902 boxed carriers, and 6836 of them program-wide are
      // property accesses; the 14349 identifier reads are largely what those
      // accesses flow into. One unfollowed edge, not thousands of decisions.
      //
      // Resolving the receiver through `layoutTypeAt` itself rather than
      // through the checker is what makes this compose: a chain
      // `a.b.c` resolves `a` from the census, `a.b` from `a`, and `a.b.c` from
      // `a.b`. `getNonNullableType` because a censused receiver routinely
      // carries the `| null` its own writes justify (`_gl` does) while every
      // read of it is guarded.
      //
      // Same shape, and the same cure, as `absent-globals.ts`'s collapse
      // needing to recurse through the receiver: reading a property of a value
      // whose type only ONE authority knows must ask that authority.
      const throughReceiver = memberThroughBoundReceiver(node)
      if (throughReceiver) return throughReceiver
    }
    // `own` is not `any` itself, but may still be a generic instantiation
    // whose OWN type argument is -- CFA narrowing an `any`-typed value against
    // a generic ambient class (`res instanceof Promise`) produces exactly this
    // shape. See `declaredGenericArmAt`.
    const recovered = declaredGenericArmAt(node, own)
    if (recovered) return recovered
    // The same statement, made about the CELL rather than about the value: an
    // annotation that states no storage its own initializer already states
    // cannot be the carrier either, or the store into it is exactly the
    // conversion the literal rule below exists to avoid --
    // `const fieldSource: Iterable<string> = { [Symbol.iterator](): FieldCursor
    // { ... } }`, where the cursor's `this.label` lives or dies on which of the
    // two the cell holds. One rule, three callers, because a cell, its
    // initializer and every read of it are ONE cell: answering the read from
    // the annotation while the cell holds the literal is the two-authority
    // split this file's own header describes.
    if (ts.isVariableDeclaration(node)) {
      const deferred = annotationDeferringToInitializer(node)
      if (deferred) return deferred
    }
    // The third caller of that same rule: the literal's own members read the
    // value through `this`, and a read answered from the annotation while the
    // value IS the literal is the identical two-authority split. Asked here,
    // where the checker's answer for the keyword would otherwise stand.
    const literalReceiver = objectLiteralMemberReceiverAt(node)
    if (literalReceiver) return literalReceiver
    const declaringCell = ts.isIdentifier(node) ? boundSymbolOf(node)?.valueDeclaration : undefined
    if (declaringCell && ts.isVariableDeclaration(declaringCell) && declaringCell.name !== node) {
      const deferred = annotationDeferringToInitializer(declaringCell)
      if (deferred) return deferred
    }
    if (!ts.isObjectLiteralExpression(node) && !ts.isArrayLiteralExpression(node)) return own
    // The `{}` of `Object.assign( {}, ...sources )` is laid out as what the
    // call makes of it, from the same authority the call's result reads.
    if (ts.isObjectLiteralExpression(node)) {
      const freshTarget = objectAssignFreshTargetType(checker, node)
      if (freshTarget) return freshTarget
    }
    // AN EMPTY ARRAY LITERAL NESTED IN ANOTHER LITERAL takes its element from
    // the position it fills, not from its own inference. `[]` alone infers
    // `never[]` (see `structural-array-element.ts`'s header for why that is a
    // mis-inference and not a statement), and its own contextual type is no
    // help when the outer literal's contextual type is a union: the checker
    // reports the union of what EVERY arm's element could be, while the outer
    // literal has already committed to one arm. hono's
    // `matchResult: Result<[unknown, RouterRoute]> = [[]]` is the case -- the
    // outer `[[]]` resolves to `Result`'s one-element arm by arity below, and
    // the inner `[]` then has exactly one thing it can be.
    const nestedPosition = emptyArrayPositionTypeOf(node)
    if (nestedPosition) return nestedPosition
    // A DEFAULT VALUE is contextually typed by the cell it fills, and when the
    // census narrowed that cell the annotation is no longer what it fills.
    // hono's `matchResult: Result<[unknown, RouterRoute]> = [[]]` is the pair:
    // the annotation states `unknown` where the only caller passes `H`, so the
    // slot carries the caller's `Result<[H, RouterRoute]>` and a literal
    // resolved against the annotation instead builds the one shape the slot
    // cannot hold. Asked here rather than left to a conversion for the reason
    // the arity rule below states -- reconciling the two rebuilds arrays.
    const parameterOfInitializer = ts.isParameter(node.parent) && node.parent.initializer === node ? node.parent : null
    const narrowedSlot = parameterOfInitializer ? parameters.statedTypeAt(parameterOfInitializer) : null
    const checkerContext = checker.getContextualType(node)
    // A call argument fills the same parameter cell as its default does.
    // In particular [] contributes no element evidence of its own; its
    // allocation must use the native element type the caller census proved
    // for that cell, rather than the erased Function/unknown annotation.
    const call = ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent) ? node.parent : null
    const argumentIndex = call?.arguments?.indexOf(node) ?? -1
    const selectedParameter =
      call && argumentIndex >= 0 && !call.arguments?.slice(0, argumentIndex).some(ts.isSpreadElement)
        ? checker.getResolvedSignature(call)?.getParameters()[argumentIndex]?.valueDeclaration
        : undefined
    const parameterContext =
      selectedParameter && ts.isParameter(selectedParameter) && !selectedParameter.dotDotDotToken
        ? (parameters.statedTypeAt(selectedParameter) ?? parameters.typeAt(selectedParameter))
        : null
    const narrowedCallSlot =
      checkerContext &&
      parameterContext &&
      containsUnstatedPosition(checker, node, checkerContext) &&
      narrowsOnlyUnstatedPositions(checker, node, checkerContext, parameterContext)
        ? parameterContext
        : null
    // JavaScript expando inference attaches the completed object shape to the
    // declaration while the fresh `{}` initializer itself remains the empty
    // object type and has no contextual type. That makes one allocation use
    // an empty struct and the cell receiving it use the completed struct,
    // even though later `data.attribute = ...` writes are mutations of this
    // very same fresh object. Allocate the declaration's inferred shape from
    // the start. This is restricted to a direct, unannotated empty-literal
    // initializer: no alias can observe a distinct object before the binding
    // is established, and a stated TypeScript annotation remains the normal
    // checker context rather than being reinterpreted here.
    const inferredDeclarationContext = (() => {
      if (!ts.isObjectLiteralExpression(node) || node.properties.length !== 0) return null
      const declaration = node.parent
      if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== node || declaration.type !== undefined) return null
      const inferred = checker.getTypeAtLocation(declaration)
      if ((inferred.flags & ts.TypeFlags.Object) === 0 || isVacuousObjectType(declaration, inferred)) return null
      return inferred
    })()
    // A literal written against a pattern whose type the checker merely
    // implied from the pattern's shape has no stated context at all: `{ x:
    // any }` for `({ x } = { x: 23 })` is the pattern's silhouette, and laying
    // the literal out by it made every field of the default dynamic where the
    // literal itself wrote a number. The literal's own type is the value.
    if (impliedPatternTargetOf(checker, node)) return own
    const contextual = narrowedSlot ?? narrowedCallSlot ?? checkerContext ?? inferredDeclarationContext
    if (!contextual || contextual.isIntersection()) return own
    let candidate = contextual.isUnion() ? soleShapedArm(contextual) : contextual
    if (candidate === null && contextual.isUnion() && ts.isObjectLiteralExpression(node)) {
      // A union can contain several object shapes while this literal satisfies
      // exactly one of them. TypeScript has already checked that relation; ask
      // its assignability rather than rebuilding a key discriminator here.
      // BSON's legacy/modern EJSON records are the concrete case: both arms
      // are objects, while `$binary: string` and `$binary: { ... }` each fit
      // only one. Allocating that declared arm directly preserves the fresh
      // object's identity and avoids a later shared-record reconstruction.
      const assignable = contextual.types.filter(
        (member) => (member.flags & ts.TypeFlags.Object) !== 0 && checker.isTypeAssignableTo(own, member)
      )
      candidate = assignable.length === 1 ? (assignable[0] ?? null) : null
    }
    if (candidate === null && contextual.isUnion() && ts.isObjectLiteralExpression(node)) {
      // A literal that SPREADS a source with no statically known own-property
      // set (a union, or a type with an index signature) is the one case
      // where `own` -- the checker's OWN inference of the literal's result --
      // cannot be trusted even as a fallback. `CopyDataProperties` copies
      // whatever keys the source holds at runtime, but the checker's
      // inference of `{ 'Content-Type': x, ...headers }` for `headers:
      // Record<'Content-Type', BaseMime> | Record<ResponseHeader, string> |
      // Record<string, string>` unions one shape per contextually-possible
      // arm of the SOURCE and drops every arm's index signature entirely --
      // `own` ends up a plain multi-arm record union with no sign the
      // dictionary keys were ever copied. A layout built from that type can
      // only ever hold the literal's own written keys, silently dropping
      // whatever the spread copies at runtime.
      //
      // The one member of `HeaderRecord`'s own arms that can genuinely hold
      // ANY key the spread might copy is its INDEX-SIGNATURE arm -- every
      // other arm is a fixed, narrower key set that a dynamic copy could
      // overflow. So when the union has EXACTLY one such arm, that arm --
      // not the whole ambiguous union, and not `own` -- is this literal's
      // layout: it is both a real member of the declared type (so the value
      // this literal builds still needs no conversion to be a `HeaderRecord`)
      // and the one shape wide enough for a runtime-enumerated copy to write
      // into. Scoped tightly to exactly the circumstance `own` cannot answer
      // -- a spread of a dynamic source is why `own` lost the index
      // signature in the first place, and a literal with no such spread
      // keeps `soleShapedArm`'s existing, deliberately conservative refusal.
      // `checker.getTypeAtLocation` directly, NOT a recursive `layoutTypeAt`
      // call: this closure is already inside `layoutTypeAt`'s own body, and a
      // spread source that is itself an object/array literal with a
      // deeply-generic contextual type (hono's router chains, measured) can
      // drive the checker's own resolution deep enough that a second,
      // mutually-recursive entry into this function overflows the call
      // stack. The raw checker type is exactly what `own` above is already
      // built from, so this loses only the parameter-census/`any`-follow
      // refinement `layoutTypeAt` layers on top -- immaterial here, since
      // this test only asks "is this shape a union or does it carry an index
      // signature", which the raw checker answer already carries correctly for a
      // union or index-signature source (this test never fires for an `any`).
      const spreadsDynamicSource = node.properties.some((property) => {
        if (!ts.isSpreadAssignment(property)) return false
        const sourceType = checker.getTypeAtLocation(property.expression)
        if (sourceType.isUnion()) return true
        if ((sourceType.flags & ts.TypeFlags.Object) === 0) return true
        return checker.getIndexInfosOfType(sourceType).length > 0
      })
      if (spreadsDynamicSource) {
        const indexed = contextual.types.filter(
          (member) => (member.flags & ts.TypeFlags.Object) !== 0 && checker.getIndexInfosOfType(member).length > 0
        )
        candidate = indexed.length === 1 ? (indexed[0] ?? null) : null
      }
    }
    if (candidate === null && contextual.isUnion() && ts.isArrayLiteralExpression(node)) {
      // A TUPLE LITERAL PICKS ITS ARM BY LENGTH, which is the language's own
      // rule and not a preference invented here: `[[]]` against
      // `[[T, ParamIndexMap][], ParamStash] | [[T, Params][]]` can only be
      // the second, because the first states two elements and the literal
      // writes one. `soleShapedArm`'s refusal above is deliberately
      // conservative about picking between arms of a union and has no notion
      // of arity to refuse on, so hono's `Result<T>` fell back to the
      // literal's own `[never[]]` -- a carrier the declared parameter cannot
      // hold, and the conversion that would fix it up rebuilds two arrays,
      // which is a COPY of an array the caller may still hold.
      //
      // Only when exactly one arm fits. Two arms of the same length is a
      // choice this cannot make, and the fallback stays.
      const fitted = contextual.types.filter(
        (member) => checker.isTupleType(member) && checker.getTypeArguments(member as ts.TypeReference).length === node.elements.length
      )
      candidate = fitted.length === 1 ? (fitted[0] ?? null) : null
    }
    if (candidate === null || !(candidate.flags & ts.TypeFlags.Object)) return own
    if (isVacuousObjectType(node, candidate)) return own
    if (statesNoStorageBeyondTheLiteral(node, candidate, own)) return own
    if (discardsLiteralAccessor(node, candidate, own)) return own
    if (ts.isArrayLiteralExpression(node) && !checker.isArrayType(candidate) && !checker.isTupleType(candidate)) return own
    // Context can state the tuple shape without stating the callable stored
    // inside it: [Function][] must not erase a literal's concrete signature.
    // The same upper-bound test the parameter census uses proves that only
    // unstated positions narrow. Empty literals supply no such evidence.
    if (
      ts.isArrayLiteralExpression(node) &&
      node.elements.length > 0 &&
      containsUnstatedPosition(checker, node, candidate) &&
      narrowsOnlyUnstatedPositions(checker, node, candidate, own)
    )
      return own
    return candidate
  }

  /**
   * Whether a contextual type from a lib declaration states no storage this
   * literal does not already state, and states it LESS precisely.
   *
   * `const fieldSource: Iterable<string> = { [Symbol.iterator](): FieldCursor
   * { ... } }`. ECMA-262 27.1 defines Iterable and Iterator as *protocols* --
   * the set of methods a value must answer to -- with no internal slot and no
   * allocation of their own, so `Iterable<string>` is a statement about how
   * this value may be USED, never about how it is stored. Adopting it as the
   * layout replaces the literal's own `[Symbol.iterator](): FieldCursor` with
   * the protocol's widened `(): Iterator<string>`, and the store of one
   * callable convention into the other has no conversion -- worse, a sliced
   * copy would rebind `next`'s receiver to the sliced record and lose the
   * `this.label` the cursor's whole body reads.
   *
   * Stated as the general property rather than by naming the iteration types,
   * because it IS the general reason a contextual type is worth adopting: a
   * declared shape earns the layout when it ADDS storage (`RequestInit`'s
   * optional members, which the literal omits and the record must still carry
   * a presence bit for) or when it supplies an identity the literal has none
   * of. One that declares only members the literal itself declares, more
   * loosely than the literal declares them, supplies neither -- it can only
   * cost precision. Lib-declared only: a PROGRAM interface is a nominal
   * identity this compiler keeps deliberately (`interface-families.ts`), and
   * the member-result census already keeps its members in agreement.
   */
  /**
   * Whether adopting a CONTEXTUAL candidate would strand one of the literal's
   * own accessor bodies with nowhere to be installed.
   *
   * An index signature is a statement about what a READ of an unnamed key
   * yields, not about how a NAMED member the literal itself declares is
   * physically stored. `@hono/node-server`'s `request.ts` types its whole
   * prototype object `Record<string | symbol, any>` -- an escape hatch for
   * attaching private state under keys the declared type cannot enumerate --
   * and then declares `get method() { return this[methodKey] }` as a real
   * accessor. `Record<K, V>` instantiated over a non-literal key (`string |
   * symbol`) has no named property at all -- `getProperties()` is empty, only
   * `getIndexInfosOfType()` answers -- so adopting it as this literal's layout
   * carries the getter's own declaration nowhere: `structural.ts`'s member
   * walk (`objectShapeOf`) enumerates the CANDIDATE's own properties, not the
   * literal's, and a key the candidate never names as a property is never
   * visited, so the accessor body is dropped before `structural-parts.ts`'s
   * `literalAccessorOf` ever gets a symbol to ask about.
   * `producers/allocations.ts` then correctly refuses ("...has nowhere to
   * install its body") -- that guard is fail-closed and right to fire; the
   * defect is here, at the choice of layout, not at that guard.
   *
   * Narrow by construction: only fires for a key the literal declares as an
   * ACCESSOR. Ordinary data needs no named slot to be installed into a
   * dictionary -- `CreateDataPropertyOrThrow` writes through the index the
   * same way regardless, which is exactly why `isVacuousObjectType` above
   * deliberately treats an index-signature type as non-vacuous (voice-notes'
   * `Record<string, string>` header literal). And a candidate that DOES name
   * the key, even as plain data (`interface C { get next(): T }`, spelled as
   * data on purpose -- see `typed-custom-iterator-close.ts`), is untouched:
   * that case already has its own path, `structural-parts.ts`'s
   * `declaredMembers.accessorBodiesOf`, which needs the candidate's own
   * property SYMBOL to attach the literal's body to, and still gets one
   * there. Only a key with NO named property in the candidate at all -- an
   * index-only escape hatch, not a declared-but-untyped-as-accessor member --
   * reaches this refusal.
   */
  const discardsLiteralAccessor = (node: ts.Node, candidate: ts.Type, own: ts.Type): boolean => {
    if (!ts.isObjectLiteralExpression(node)) return false
    return own.getProperties().some((property) => {
      if ((property.getFlags() & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) === 0) return false
      return checker.getPropertyOfType(candidate, property.getName()) === undefined
    })
  }

  const statesNoStorageBeyondTheLiteral = (node: ts.Node, candidate: ts.Type, own: ts.Type): boolean => {
    if (!ts.isObjectLiteralExpression(node)) return false
    const declarations = candidate.getSymbol()?.declarations ?? []
    if (declarations.length === 0 || !declarations.every((declaration) => declaration.getSourceFile().hasNoDefaultLib)) return false
    const members = candidate.getProperties()
    if (members.length === 0) return false
    const mine = own.getProperties()
    let widened = false
    for (const member of members) {
      const implemented = mine.find((property) => property.escapedName === member.escapedName)
      if (!implemented) return false
      const declaredType = checker.getTypeOfSymbolAtLocation(member, node)
      const ownType = checker.getTypeOfSymbolAtLocation(implemented, node)
      if (declaredType === ownType) continue
      // Narrower in the literal is the only direction this rule may fire on:
      // a literal member the declaration does NOT accept is a mis-inference
      // the declared shape is there to correct, and must keep correcting.
      if (!checker.isTypeAssignableTo(ownType, declaredType)) return false
      if (!checker.isTypeAssignableTo(declaredType, ownType)) widened = true
    }
    return widened
  }

  /**
   * The carrier of an annotated cell whose annotation is one the literal
   * filling it already refused -- `null` for every other cell.
   *
   * Two reasons, both of them the literal's own rule asked a second time
   * about the CELL, because a cell, its initializer and every read of it are
   * one cell: `statesNoStorageBeyondTheLiteral` (the annotation adds nothing
   * and loses precision) and `discardsLiteralAccessor` (the annotation names
   * no property the literal declares as an accessor, so adopting it would
   * strand the body). Sharing the predicates rather than restating them is
   * what keeps the cell and the value one answer: an annotation the literal
   * declined, left standing on the cell, IS the store the literal rule exists
   * to avoid -- `@hono/node-server`'s `requestPrototype` built a
   * `native-record-ref` while its `Record<string | symbol, any>` cell
   * declared a `record-with-index`, and there is no conversion between them.
   */
  const annotationDeferringToInitializer = (declaration: ts.VariableDeclaration): ts.Type | null => {
    if (!declaration.type || !declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) return null
    const stated = layoutTypeOf(declaration.initializer)
    const annotation = checker.getTypeAtLocation(declaration)
    if (statesNoStorageBeyondTheLiteral(declaration.initializer, annotation, stated)) return stated
    return discardsLiteralAccessor(declaration.initializer, annotation, stated) ? stated : null
  }

  /**
   * `this`, read inside a member of an object literal whose LAYOUT refused
   * that literal's contextual type.
   *
   * ECMA-262 binds an object literal method's `this` to the object the call
   * resolved on, and TypeScript types the keyword from the literal's
   * CONTEXTUAL type (`getContextualThisParameterType` widens the literal's
   * context when no `ThisType<T>` overrides it). That is the same question
   * this resolver answers for the literal itself -- and where it answers
   * differently (`discardsLiteralAccessor` above, which refuses an
   * index-signature annotation that would strand a getter body), the two
   * answers describe ONE value: the frame's receiver, which
   * `structural-receiver.ts`'s `implicitReceiverOf` takes from
   * `layoutTypeAt(literal)`, and the read of it inside the body. Leaving the
   * read on the refused annotation is that split, and `ir/verify.ts` names it
   * exactly -- `@hono/node-server`'s `get method() { return this[methodKey] }`
   * reported nine bodies whose `this` operand expected the annotation's
   * `record-with-index` while its definition selected the literal's own
   * `native-record-ref`. The layout is the authority for what the value
   * physically is, so it answers the read too.
   *
   * Fires ONLY where the two already disagree, so it cannot move a program
   * whose literal adopted its context: the identity test demands that the
   * checker resolved this very keyword FROM that contextual type (a
   * descriptor literal's `ThisType<any>` answers `any` instead, and the
   * vacuous guard refuses it outright -- its receiver is the defineProperty
   * TARGET, which no contextual type here spells), and the final test
   * returns nothing when the layout adopted the context.
   */
  const objectLiteralMemberReceiverAt = (node: ts.Node): ts.Type | null => {
    if (node.kind !== ts.SyntaxKind.ThisKeyword) return null
    // An arrow closes over the enclosing frame's `this` rather than binding
    // one, so it is walked THROUGH -- the same scoping `bodyReadsThis` and
    // `implicitReceiverOf` use to decide whose receiver this keyword reads.
    const frame = ts.findAncestor(node, (candidate) => ts.isFunctionLike(candidate) && !ts.isArrowFunction(candidate))
    const literal = frame && ts.isFunctionLike(frame) ? objectLiteralOwningMember(frame) : null
    if (!literal) return null
    const contextual = checker.getContextualType(literal)
    if (!contextual || (contextual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return null
    if (checker.getTypeAtLocation(node) !== contextual) return null
    const layout = layoutTypeAt(literal)
    return layout === contextual ? null : layout
  }

  /**
   * The object literal this function-like is a member of -- both spellings
   * `getContainingObjectLiteral` accepts, since `o.m()` binds the literal as
   * the receiver either way and `structural-receiver.ts` already gives both
   * the same implicit receiver.
   */
  const objectLiteralOwningMember = (frame: ts.SignatureDeclaration): ts.ObjectLiteralExpression | null => {
    const parent = frame.parent
    if (ts.isMethodDeclaration(frame) || ts.isGetAccessorDeclaration(frame) || ts.isSetAccessorDeclaration(frame))
      return ts.isObjectLiteralExpression(parent) ? parent : null
    if (ts.isFunctionExpression(frame) && ts.isPropertyAssignment(parent) && ts.isObjectLiteralExpression(parent.parent))
      return parent.parent
    return null
  }

  /** Whether two types have any value in common at all, tested the only way a type system can: assignability, in BOTH directions, so a subset overlaps its superset. */
  const overlaps = (left: ts.Type, right: ts.Type): boolean =>
    checker.isTypeAssignableTo(left, right) || checker.isTypeAssignableTo(right, left)

  /**
   * A UNION NARROWED BY A NARROWING OF ONE OF ITS MEMBERS.
   *
   * `arg: ResponseInit | Response`, and hono's `#newResponse` writes
   *
   *   const argHeaders = arg.headers instanceof Headers ? arg.headers : new Headers( arg.headers )
   *
   * In the else arm the checker types `arg.headers` as everything BUT
   * `Headers` -- and leaves `arg` itself alone, because TypeScript narrows an
   * object from a discriminant LITERAL check and not from an `instanceof` on
   * one of its members. So the receiver's carrier still had both arms while
   * the read published a union with no `Headers` in it, and the emitter's
   * arm dispatch reached the `Response` arm, whose `headers` field IS a
   * `Headers`, with nothing sound to convert it into. Failing closed there is
   * right (`emit-union-properties.ts` says so at both of its refusals) --
   * the defect is that the receiver lost a narrowing the program made.
   *
   * The inference is the language's own contrapositive, and does not need
   * TypeScript to make it: if the value read out of `p` cannot be anything
   * this arm's `p` can hold, this arm is not what the receiver holds here.
   * Both directions of assignability have to fail before an arm is dropped,
   * so an arm whose member is a SUPERSET of the narrowing (or a subset of it)
   * stays -- only a genuinely disjoint one goes. An arm that lacks the
   * property entirely also stays: the language answers that read `undefined`
   * (10.1.8 step 3) and the emitter already renders exactly that.
   *
   * `any`/`unknown` on either side is not a narrowing and stops this: those
   * are the absences the censuses exist to fill, and every arm "overlaps"
   * them.
   */
  const armsLiveUnderMemberNarrowing = (node: ts.Node, answer: ts.Type): ts.Type | null => {
    const read = node.parent
    if (!read || !ts.isPropertyAccessExpression(read) || read.expression !== node) return null
    if (!answer.isUnion()) return null
    const vacuous = ts.TypeFlags.Any | ts.TypeFlags.Unknown
    const narrowed = checker.getTypeAtLocation(read)
    if ((narrowed.flags & vacuous) !== 0) return null
    const live = answer.types.filter((arm) => {
      const property = checker.getPropertyOfType(arm, read.name.text)
      if (!property) return true
      const held = checker.getTypeOfSymbolAtLocation(property, read)
      if ((held.flags & vacuous) !== 0) return true
      return overlaps(held, narrowed)
    })
    if (live.length === answer.types.length || live.length === 0) return null
    const sole = live.length === 1 ? live[0] : undefined
    if (sole) return sole
    const constructing = checker as unknown as { getUnionType?: (types: readonly ts.Type[]) => ts.Type }
    return typeof constructing.getUnionType === 'function' ? constructing.getUnionType(live) : null
  }

  // A resolver closes over one checker and one census snapshot. Reusing an
  // answer here cannot cross binding-fixpoint rounds or checker lifetimes.
  const answers = new WeakMap<ts.Node, ts.Type>()
  const layoutTypeAt = (node: ts.Node): ts.Type => {
    const known = answers.get(node)
    if (known) return known
    const answer = layoutTypeOf(node)
    const selected = armsLiveUnderMemberNarrowing(node, answer) ?? answer
    answers.set(node, selected)
    return selected
  }

  return layoutTypeAt
}
