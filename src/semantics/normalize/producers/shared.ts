import ts from 'typescript'
import type { SpecializationPath } from '../identities.js'
import { genericFunctionSetMembersOf, runtimeSymbolMemberIndexOf } from '../../model/structural-types.js'
import { isFabricatedSignatureShape } from '../structural-callable.js'
import type { OperationId, StructuralTypeId } from '../../../identity/ids.js'
import type { SemanticEdge, ValueEdge } from '../../model/edges.js'
import type { OperandSource, SemanticOperand } from '../../model/operands.js'
import type { CandidateContribution } from '../contribution.js'
import { symbolPropertyKeyText, type StructuralMember, type StructuralShape } from '../../model/structural-types.js'
import { symbolKeyDeclarationOf } from '../structural-leaves.js'
import { blocked } from './mint.js'
import type { ProducerContext } from '../producer-context.js'
import { citeExpressionResult, type CitedBranch } from './references.js'
import { isShortCircuitingCall, presentReturnTypeOf } from './optional-chain.js'
import { enclosingCallIfCallee } from './erasure.js'
import { implementationSignatureOf, physicalOverloadTypeAt } from '../structural-declarations.js'
export { unwrapErasedExpression as unwrapErased } from './erasure.js'
import { unwrapErasedExpression } from './erasure.js'

/**
 * Helpers every producer needs, kept in one place.
 *
 * Each of these existed as three or four private copies, and the copies did not
 * stay identical: one `resultEdge` published ordinal zero for every operand
 * while another carried the real one, so two producers disagreed about which
 * operand an edge described. A duplicated helper is not a style problem here --
 * it is a second authority waiting to drift, and drift in this layer is silent
 * (a wrong citation produces no error, just an operation that never appears).
 */

/** `blocked()` mints a `CensusBlocker`; a producer's `contribute` must return a `CandidateContribution`. */
export const asBlocked = (...args: Parameters<typeof blocked>): CandidateContribution => ({ kind: 'blocked', blocker: blocked(...args) })

/**
 * The `ValueEdge` a cited result needs to stay visible to whole-program
 * authority-connectivity analysis. A `constant`/`absent` source crosses no
 * operation boundary, so it needs none.
 *
 * The ordinal is a parameter and not a constant: an operand's role and ordinal
 * together name it, and an edge that always claimed ordinal zero would describe
 * the first argument of a call no matter which argument it actually carried.
 */
export const resultEdge = (source: OperandSource, to: OperationId, role: string, ordinal: number): SemanticEdge | null =>
  source.kind === 'result' ? { kind: 'value', result: source.result, to, role, ordinal } : null

/** Every operand of an operation that cites a result, as edges into it. */
export const valueEdgesInto = (to: OperationId, operands: readonly SemanticOperand[]): SemanticEdge[] =>
  operands.flatMap((entry): ValueEdge[] =>
    entry.source.kind === 'result' ? [{ kind: 'value', result: entry.source.result, to, role: entry.role, ordinal: entry.ordinal }] : []
  )

export const isAssignmentOperatorKind = (kind: ts.SyntaxKind): boolean =>
  kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment

/**
 * Whether this source position evaluates in ECMAScript strict mode.
 *
 * An ES MODULE is strict in its entirety, unconditionally (ECMA-262 11.2.2) --
 * no prologue, no `export`, nothing else required.
 *
 * Established against real `node`, not argued: the same `delete` of a
 * non-configurable property answers `false` when the emitted file is loaded as
 * CommonJS and throws `TypeError` when it is loaded as an ES module. Both
 * `strict-delete.ts` and `native-handle-computed-access.runtime.js` throw under
 * the module setting their own tsconfig states.
 *
 * THE `module` SETTING IS NOT THE QUESTION. It used to short-circuit this walk
 * -- `module: ESNext` was read as "every file is a module, so every file is
 * strict" -- and that is false for a file with no import and no export, which
 * is a Script whatever the emit setting says. What actually makes every file in
 * a build strict is `alwaysStrict` (implied by `strict`): tsc parses strict and
 * writes a `'use strict'` prologue into each emitted file. That is
 * `buildIsStrict`, and it is the only whole-build fact this needs; the rest --
 * external module, prologue, class body -- is per position and walked here.
 *
 * `test/runtime/tsconfig.json` sets `strict: true`, so the suite's answer does
 * not change. A build with `module: CommonJS` and `strict: true` was the case
 * this got wrong in both directions at once.
 */
export const isStrictContext = (node: ts.Node, buildIsStrict: boolean): boolean => {
  if (buildIsStrict) return true
  const hasDirective = (statements: readonly ts.Statement[]): boolean => {
    for (const statement of statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false
      if (statement.expression.text === 'use strict') return true
    }
    return false
  }
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    // Every class definition and all code nested inside it is strict.
    if (ts.isClassLike(current)) return true
    if (
      ts.isFunctionLike(current) &&
      'body' in current &&
      current.body !== undefined &&
      ts.isBlock(current.body) &&
      hasDirective(current.body.statements)
    )
      return true
    if (ts.isSourceFile(current)) return ts.isExternalModule(current) || hasDirective(current.statements)
  }
  return false
}

/**
 * A logical assignment writes only when the short-circuit does not fire, so it
 * is not a read-operate-write at all; decomposing it as one would write a value
 * the source program leaves untouched.
 */
export const logicalAssignmentOperators: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken
])

/**
 * A compound assignment reads its target, so the property and computation
 * families must agree on exactly which operators those are. Derived from the
 * assignment range minus the two forms that are not read-operate-write.
 */
export const isCompoundAssignmentOperator = (kind: ts.SyntaxKind): boolean =>
  isAssignmentOperatorKind(kind) && kind !== ts.SyntaxKind.EqualsToken && !logicalAssignmentOperators.has(kind)

/**
 * Where an expression's value comes from, as an operand source.
 *
 * The identity is predictive, not observed: the owning family's producer mints
 * this exact id independently from the same node, so the graph is wired by
 * agreement on identity and never by execution order. Citation has exactly one
 * implementation for that agreement to be worth anything -- three private
 * copies of this drifted from it, kept citing a name's Reference Record after
 * the shared rule moved to the value GetValue publishes, and every operand they
 * built named a result nobody published. The publication guard then withheld
 * those operations silently: no error, no blocker, just missing operations.
 *
 * The throw is deliberate. Every runtime-producing expression is censused, a
 * literal, or `this`/`super`; reaching it means a form exists that neither this
 * layer nor the census knows about, which is an implementation gap to fix here
 * rather than a missing capability to report about the program.
 */
export const sourceForValue = (context: ProducerContext, expr: ts.Expression, branch: CitedBranch = 'expression'): OperandSource => {
  const cited = citeExpressionResult(expr, context, branch)
  if (cited.kind === 'unmodelled') throw new Error(cited.reason)
  return cited.source
}

/**
 * The type of an expression's value, resolved through the specific call it is
 * invoked by when it is one's callee.
 *
 * `arr.map`'s own type carries `map`'s unbound `<U>`: nothing at that
 * position has committed to a value for it. But when this exact expression is
 * the callee of an enclosing call, the checker already committed -- resolving
 * that call over its overload set and inferring its type arguments is what
 * type-checking the call *is* -- so `getResolvedSignature` on the call reads
 * back an answer the checker already computed, rather than this layer
 * re-deriving one. Every other position keeps the plain property type: a
 * value merely stored or passed around, never called from here, has made no
 * such commitment for this layer to read back.
 *
 * `properties.ts` and `invocations.ts` both need this exact answer for the
 * same expression -- the property access publishes it as its own result, and
 * the call cites that result as its callee operand -- and they get it without
 * coordinating: `StructuralTypeTable.intern` dedupes by the shape's own
 * canonical key, so two independent calls into `resolvedSignatureTypeOf` with
 * the same resolved signature converge on one id instead of two.
 */
/**
 * TypeScript's own `anySignature`: what `getResolvedSignature` returns for a
 * call it did not check.
 *
 * It stands for "this call was not checked", never for a convention anything
 * has, so interning it produces a callable carrier whose ABI declares no
 * parameters at all -- `fn(a, b, c)` acquires a callee that takes none.
 * Recognized by all three of its properties together: a real signature always
 * has a declaration, and testing parameter count alone would catch every
 * genuinely nullary function.
 *
 * The checker's own type at the callee is required to be `any` as well. That
 * is the fact that makes the fabricated signature meaningless -- and the fact
 * `parameter-bindings.ts` was written to answer.
 */
// Deliberately checker-only, not a bypass: this detects exactly the case
// where the CHECKER committed to nothing (its raw answer is `any`) so the
// caller (`resolvedCalleeSignatureType` below, ~line 231's own comment) knows
// to prefer the census's answer over this fabricated signature instead of
// interning it. Routing this test itself through the census would defeat the
// test it exists to run.
const isFabricatedAnySignature = (checker: ts.TypeChecker, node: ts.Expression, signature: ts.Signature): boolean =>
  (checker.getTypeAtLocation(node).flags & ts.TypeFlags.Any) !== 0 && isFabricatedSignatureShape(checker, signature)

/**
 * A property access whose member is annotated with an overload set and
 * initialized with one physical function -- the member spelling of the
 * binding case `physicalOverloadTypeAt` already answers.
 *
 * The declaration is reached through the member SYMBOL rather than through the
 * access node, because the access has no declaration of its own; a symbol with
 * no value declaration, or one the overload rule declines, answers `null` and
 * the resolved signature stands as before.
 */
/**
 * Where the callee VALUE is declared -- which is what says whose frame binds
 * the type parameters its type mentions.
 *
 * Not the same question as where the signature's SYNTAX lives, and hono is
 * where the two come apart: `type GetPath<E> = (request: Request, options?:
 * { env?: E['Bindings'] }) => string` puts the signature node at hono-base's
 * MODULE scope, while the value it types -- `readonly getPath: GetPath<E>` --
 * is a member of the class whose `E` it names. Scoping the callee's view by
 * the signature node truncated the specialization path to nothing, so `E` was
 * answered by its own DEFAULT (`Env`) instead of by the copy's binding
 * (`BlankEnv`), and the call published a record the class's own field layout
 * -- built in that copy -- does not have.
 *
 * A plain identifier callee answers the same declaration either way, so the
 * case `signature.declaration` was introduced for (`parseBody(this, options)`
 * resolved under the caller's frame, minting a second `HonoRequest`) keeps its
 * answer: an imported binding's value declaration is at module scope, and the
 * prefix truncates there exactly as before.
 */
const calleeValueDeclarationAt = (context: ProducerContext, node: ts.Expression): ts.Declaration | null => {
  const name = ts.isPropertyAccessExpression(node) ? node.name : ts.isIdentifier(node) ? node : null
  if (!name) return null
  const symbol = context.checker.getSymbolAtLocation(name)
  return symbol ? context.identities.valueDeclarationOfSymbol(symbol) : null
}

/**
 * The member type, re-resolved on the receiver THIS COPY substituted -- or
 * `null` when the receiver is not a parameter this copy binds.
 *
 * TypeScript resolves `operation.weight` on `T`'s apparent type, its
 * CONSTRAINT, because that is all the language knows about `T` while checking
 * one generic body. A monomorphized copy knows more: its receiver really is a
 * `Heavy`, and the member that names is `Heavy`'s own override. So the member
 * is looked up again on the bound type, which is not a second opinion but the
 * same lookup asked with the fact the copy added.
 *
 * Scoped by the SUBSTITUTION rather than by "is this a type parameter": an
 * uninstantiated parameter is one no copy answers for, and its
 * constraint-resolved signature is the only answer there is.
 */
const substitutedReceiverMemberType = (context: ProducerContext, node: ts.Expression): ts.Type | null => {
  if (!ts.isPropertyAccessExpression(node)) return null
  const receiver = context.checker.getTypeAtLocation(node.expression)
  if ((receiver.flags & ts.TypeFlags.TypeParameter) === 0) return null
  const bound = context.types.substituteTypeParameter(receiver)
  if (bound === receiver) return null
  const member = bound.getProperty(node.name.text)
  return member ? context.checker.getTypeOfSymbolAtLocation(member, node) : null
}

const physicalMemberOverloadTypeAt = (context: ProducerContext, node: ts.Expression): ts.Type | null => {
  if (!ts.isPropertyAccessExpression(node)) return null
  const symbol = context.checker.getSymbolAtLocation(node.name)
  const declaration = symbol?.valueDeclaration
  if (!declaration) return null
  const physical = physicalOverloadTypeAt(context.checker, declaration)
  if (physical !== null) return physical
  // The same member, with NO initializer to name the one physical function.
  // hono's `get!: HandlerInterface<...>` is filled in the constructor by
  // `allMethods.forEach((method) => { this[method] = (args1, ...args) => ... })`,
  // so the declaration carries only the overload set -- and that overload set
  // is exactly what the class layout spelled for the cell (one `gea::Value`,
  // since no single convention derives from an overloaded type).
  //
  // The reasoning is the paragraph above's, not a weaker version of it: an
  // overload set is a type-level fiction over a single runtime function, so
  // whichever overload THIS call site matched says nothing about the physical
  // shape of the callable the cell holds. The only difference is which answer
  // agrees with the layout: with an initializer it is the literal's own
  // convention, without one it is the declared type itself. Believing the
  // resolved overload instead published a `CallableObject<Sig>` for a member
  // stored as `gea::Value`, and the unbox in between asserts a payload type
  // the writer never wrote -- `app.get('/', handler)` aborted on the program's
  // first statement rather than failing to compile.
  //
  // Gated to a PROPERTY with no initializer, so nothing that already resolves
  // through the checker's overload resolution is re-derived: a METHOD is
  // reached by name and rendered per signature with no cell involved, which
  // is every `lib.d.ts` overload set (`Array.prototype.map`,
  // `String.prototype.replace`), and those keep their answer.
  if (!ts.isPropertyDeclaration(declaration) || declaration.initializer !== undefined) return null
  const declared = context.checker.getTypeAtLocation(declaration)
  return declared.getCallSignatures().length >= 2 ? declared : null
}

/**
 * `Object.getOwnPropertyDescriptor(receiver, key)`'s result, minted from the
 * RECEIVER's own structural shape rather than the ambient `PropertyDescriptor`
 * interface's own declared `value?: any` -- see `structural.ts`'s own
 * `objectDescriptorReturnTypeAt` for the full reasoning and the actual
 * decision. Delegates rather than re-deriving: `context.types.typeAt(call)`
 * (the general per-node structural authority, asked by a property access's
 * own receiver typing, a local binding's declared type, and everything else
 * that asks "what is this node's type") already computes this exact answer
 * for the bare CallExpression, and `validateInvocationResult`
 * (`model/selected-signature.ts`) requires this producer's own
 * `resultType`/`selectedSignature.returnType` to agree with it exactly --
 * two independently-written copies of the same decision is precisely the
 * shape that disagreement bit once already this session (a `buildSelectedSignature`-only
 * version published a native record for the call's own SSA value while
 * `context.types.typeAt` kept answering the old boxed one for every other
 * reader of the same node).
 */
export const objectDescriptorReturnTypeAt = (
  context: ProducerContext,
  call: ts.CallExpression | ts.NewExpression
): StructuralTypeId | null => context.types.objectDescriptorReturnTypeAt(call)

/**
 * The type of the ONE function a callee value physically is, when its
 * declaration annotates it with an overload set and initializes it with a
 * single function literal -- `structural-declarations.ts`'s
 * `physicalOverloadTypeAt`, reached through either spelling a callee has.
 *
 * A bare binding reference is that function's own rule verbatim. A property
 * access has no declaration of its own, so the member SYMBOL's is resolved
 * first -- the identical indirection `physicalMemberOverloadTypeAt` below
 * already performs, and deliberately the same rule rather than a second one:
 * the two must agree about how many conventions one value has, or the member
 * read and the call through it publish different carriers for one cell.
 */
const physicalCalleeValueTypeOf = (checker: ts.TypeChecker, callee: ts.Expression): ts.Type | null => {
  if (ts.isPropertyAccessExpression(callee)) {
    const declaration = checker.getSymbolAtLocation(callee.name)?.valueDeclaration
    return declaration ? physicalOverloadTypeAt(checker, declaration) : null
  }
  return physicalOverloadTypeAt(checker, callee)
}

/**
 * Whether a resolved signature's type parameters belong to no body this
 * compiler copies: they are declared by a function TYPE, or were propagated
 * onto a signature whose own declaration writes none.
 */
const isGenericCallableValue = (checker: ts.TypeChecker, callee: ts.Expression): boolean => {
  // The VALUE's type, not the call's resolved signature: an instantiated
  // signature has no type parameters left to see.
  //
  // And the value's PHYSICAL type wherever the declaration names one, not the
  // annotation the checker answers with. hono's `Context.text: TextRespond =
  // (text, arg, headers) => {...}` and `Context.json: JSONRespond = <T, U>
  // (object, arg, headers) => {...}` (`context.ts`) are the shape: the
  // annotation is an interface of GENERIC call signatures, so the test below
  // saw a non-ambient `CallSignatureDeclaration` and said "generic callable
  // value" -- which publishes the ANNOTATION as the callee carrier. Those
  // overloads disagree at parameter 1 and join into no single convention, so
  // the carrier settled on `callable-identity` and the call had no invoke
  // path at all (`call-abi:no-invoke-path:callable-identity`), while the
  // class LAYOUT -- which reads the same declaration through
  // `physicalInitializerTypeOf` -- had stored the one arrow's real
  // convention all along. Two authorities over one cell, and the one with no
  // runtime referent was winning.
  //
  // Asking the literal is not a weaker question, it is the same question
  // asked of the thing that exists: whether the FUNCTION THAT WAS ALLOCATED
  // writes type parameters of its own decides whether a copy per call is
  // owed, and an annotation's overload set never does (ECMA-262 has no
  // overloads). A generic literal (`respond: Respond = <T, U>(value, arg) =>
  // {...}`, `test/runtime/generic-field-initializer.ts`) still answers
  // through the ordinary body rule below, on its own declaration.
  const valueType = physicalCalleeValueTypeOf(checker, callee) ?? checker.getTypeAtLocation(callee)
  const generic = valueType.getCallSignatures().find((one) => (one.getTypeParameters()?.length ?? 0) > 0)
  const declaration = generic?.declaration
  if (!declaration) return false
  if (ts.isFunctionTypeNode(declaration) || ts.isConstructorTypeNode(declaration)) return true
  // A call signature an interface or type literal declares (`interface
  // NodeVisitor { <TIn, TOut>(node: TIn, ...): TOut; ... }`, TypeScript's own)
  // is the same thing as a function type node -- a callable TYPE, with no
  // body of its own to copy -- and a value of it is one function at runtime
  // over the set's joined convention (`representation/host-abi.ts`'s
  // `widestSubsumingAbi`). An ambient one keeps the checker's answer: a host
  // handle's overload set is rendered per selected signature, never through a
  // cell holding the joined frame.
  if (ts.isCallSignatureDeclaration(declaration) || ts.isConstructSignatureDeclaration(declaration)) {
    return !declaration.getSourceFile().isDeclarationFile
  }
  // A body that writes its own parameters is copied per call; an ambient one
  // is the host's, instantiated by the checker at each call. Propagated
  // parameters on a declaration that writes none are the closure case.
  return (declaration.typeParameters?.length ?? 0) === 0 && !declaration.getSourceFile().isDeclarationFile
}

/**
 * The one overload of `plain` a call with this many arguments admits, when
 * `plain` is an overload set and exactly one member admits the count -- else
 * `plain` unchanged.
 *
 * A receiver the checker carries as `any` resolves every call to its
 * fabricated no-parameter signature; the callee's PLAIN type is then the
 * census's own answer for the member, and for a library method that is the
 * whole declared overload set. Publishing the set leaves the carrier to pick
 * a frame by joining the overloads, and the joined `Array.prototype.splice`
 * frame is the two-parameter one: `levels.splice( l, 0, level )` in three's
 * `LOD.addLevel` (`levels` read through a descriptor-defined field the
 * checker cannot see) then reached the emitter with its item UNPACKED, since
 * the joined convention declared no rest slot to pack it into. Overload
 * resolution by arity is the checker's own first step (ECMA-262 has no
 * overloads; TypeScript's `chooseOverload` discards candidates the argument
 * count rules out before it compares a single type), so it is the part that
 * can be repeated here without a receiver the checker will type; when more
 * than one overload survives the count, the set stays whole rather than
 * guessing.
 */
const arityResolvedOverload = (context: ProducerContext, plain: StructuralTypeId, call: ts.CallLikeExpression): StructuralTypeId => {
  const shape = context.table.get(plain).shape
  if (shape.kind !== 'signature' || shape.generic !== undefined) return plain
  if (!ts.isCallExpression(call) && !ts.isNewExpression(call)) return plain
  const construct = ts.isNewExpression(call)
  const overloads = construct ? shape.construct : shape.call
  if (overloads.length < 2) return plain
  const supplied = call.arguments ?? []
  if (supplied.some((argument) => ts.isSpreadElement(argument))) return plain
  const count = supplied.length
  const admitted = overloads.filter((overload) => {
    if (count < overload.minimumArity) return false
    const last = overload.parameters[overload.parameters.length - 1]
    return (last?.rest ?? false) || count <= overload.parameters.length
  })
  if (admitted.length !== 1) return plain
  return context.table.intern({
    kind: 'signature',
    call: construct ? [] : admitted,
    construct: construct ? admitted : []
  })
}

/**
 * The class copy a method call's receiver is an instance of, as the path the
 * callee's frame should be typed under, or `null` when the callee is not a
 * member of a generic class whose copies can differ in layout, or the
 * receiver names no copy of that class.
 */
/** The generic class a `new` constructs, when its copies can differ in layout; `null` otherwise. */
const constructedGenericClassOf = (context: ProducerContext, declaration: ts.Declaration | undefined): ts.ClassLikeDeclaration | null => {
  const owner =
    declaration === undefined
      ? null
      : ts.isClassLike(declaration)
        ? declaration
        : ts.isConstructorDeclaration(declaration)
          ? declaration.parent
          : null
  return owner && ts.isClassLike(owner) && context.specializations.copiesMayDifferInLayout(owner) ? owner : null
}

const instanceCopyOfMethodReceiver = (
  context: ProducerContext,
  node: ts.Expression,
  declaration: ts.Declaration
): SpecializationPath | null => {
  const callee = unwrapErasedExpression(node)
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return null
  const owner = declaration.parent
  if (!owner || !ts.isClassLike(owner) || !context.specializations.copiesMayDifferInLayout(owner)) return null
  if (!(ts.isMethodDeclaration(declaration) || ts.isGetAccessorDeclaration(declaration) || ts.isPropertyDeclaration(declaration)))
    return null
  if (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Static) return null
  const receiver = context.types.rawTypeAt(callee.expression)
  const copy = context.specializations.specializationOfInstance(receiver, context.types.substituteTypeParameter)
  if (!copy || copy.declaration !== owner) return null
  const enclosing = context.identities.prefixFor(owner, context.path).filter((step) => step.owner !== owner)
  return [...enclosing, { owner, ordinal: copy.ordinal }]
}

export const resolvedCalleeSignatureType = (context: ProducerContext, node: ts.Expression): StructuralTypeId | null => {
  const call = enclosingCallIfCallee(node)
  const signature = call ? context.checker.getResolvedSignature(call) : undefined
  if (!call || !signature) return null
  const mutableMethod = context.types.mutableMethodReadTypeAt(node)
  if (mutableMethod !== null) return mutableMethod
  // `xs.push(v)` on an evolving `var xs = []`: the checker resolves the call
  // over the receiver's stale `any[]`/`never[]`, and publishing that here
  // would box every argument on its way into an array whose storage the
  // census already narrowed. The member read's own answer (`structural.ts`'s
  // `evolvingArrayMemberTypeAt`) carries the census's element; it is the same
  // authority the receiver's storage was chosen by, so it wins here too.
  const evolvingMember = context.types.evolvingArrayMemberTypeAt(node)
  if (evolvingMember !== null) return evolvingMember
  // A callee that is a CHOICE of generic functions keeps its own type: the
  // signature the checker resolved is one it combined from the members, and
  // no callable of that frame exists -- the value is the set's tag, and the
  // call's `closed-family` target names the copy each member runs
  // (`producers/invocations.ts`'s `genericSetFamilyTarget`).
  const plainType = context.types.typeAt(node)
  if (genericFunctionSetMembersOf((id) => context.table.get(id).shape, context.table.get(plainType).shape)) return plainType
  // A callee whose VALUE is a generic callable with no copies of its own -- a
  // parameter or field typed `<T extends Node>(node: T) => void`
  // (emitter.ts's `EmitFunction`), or the closure a higher-order call
  // returned with a generic argument's parameters propagated into it
  // (`memoizeOne(<T extends JSDocType>(kind) => ...)`) -- is ONE function at
  // runtime, over its constraints (`structural.ts`'s callable-owned rule).
  // The checker instantiates such a signature afresh at every call
  // (`emitFn(child)` reads its `T` as `Child`), and publishing that here made
  // the callee's carrier disagree with the cell it was just read from at every
  // call. The value's own type is the frame; the call converts to it.
  if (isGenericCallableValue(context.checker, unwrapErasedExpression(node))) return plainType
  // `node`'s own declared type is a property of ITS declaration, not of the
  // caller's specialization frame -- the same leak `buildSelectedSignature`
  // (`producers/invocations.ts`) fixes for a signature's parameters/return,
  // here for the callee VALUE itself. Resolving `parseBody`'s type through
  // `context.types` unfiltered mints `HonoRequest` (nested in `parseBody`'s
  // own declared parameter type, `utils/body.ts`) under the CALLER's frame
  // whenever the call site happens to sit inside a same-named class's own
  // copy -- `HonoRequest.parseBody`'s body calling `parseBody(this,
  // options)` is exactly that, and it is what left `request.ts:217`'s
  // binding-read-conversion stuck even after the guard below (comment
  // above `physicalOverloadTypeAt`) fixed the overloaded-signature gap: the
  // guard changed WHICH shape `plain` resolves as, not WHICH VIEW resolves
  // it. `signature.declaration` is absent only for a fabricated signature
  // (no physical function backs it), where there is no callee declaration
  // to scope by and the caller's own view is the only one that applies.
  //
  // The CALLER's path goes in as the binding path, because a resolved
  // signature is a hybrid and the two halves come from different frames: its
  // SHAPE is the callee's declaration -- which is what the scoping above is
  // for -- while its type ARGUMENTS are whatever the checker substituted from
  // the caller's own. `outer<T>(op: T) { inner(op) }` resolves `inner` to
  // `(operation: T) => number` over the CALLER's `T`, and scoping that wholly
  // to the callee left the parameter with nothing to bind it: the callee
  // carrier published `function-value-dispatch((unresolved(type parameter T))
  // -> number)` in every copy, identically, which is the naked hole
  // monomorphization exists to remove reappearing at the callee. Scoping it
  // wholly to the caller instead is what the `HonoRequest` comment above
  // rules out. Neither path answers both halves, so each half is taken from
  // the frame that owns it.
  const declaration = calleeValueDeclarationAt(context, node) ?? signature.declaration
  // A method of a generic class whose copies can differ in layout, called
  // on a receiver that is one instantiation of it (`numbers.pick('a')`,
  // `numbers: Box<number>`): the frame is the copy's, because its implicit
  // receiver is `Box<T>` and only the copy binds `T` to the layout the
  // receiver carries -- the generic-function branch below does the same for
  // a call the census keyed on a copy, and this is the class-shaped half of
  // it. A class with one layout is left on the caller's view exactly as
  // before (`SpecializationCensus.copiesMayDifferInLayout`).
  const receiverCopy = declaration ? instanceCopyOfMethodReceiver(context, node, declaration) : null
  const calleeTypes = receiverCopy
    ? context.types.forSpecialization(receiverCopy, [...context.path, receiverCopy[receiverCopy.length - 1]!])
    : declaration
      ? context.types.forSpecialization(context.identities.prefixFor(declaration, context.path), context.path)
      : context.types
  // A `new` on a generic CLASS whose copies can differ in layout: the
  // constructor declares no type parameters of its OWN -- `T` belongs to the
  // class -- so the generic-implementation branch below never fires for one,
  // and the callee was typed in whatever copy of the class the SITE happens to
  // sit inside. Inside `Box<T>.map<R>`, `new Box<R>(...)` was therefore
  // typed as `Box<T>`: the copy the site is IN rather than the copy it
  // NAMES, which is only invisible while every copy shares one struct. The
  // census keys a new-expression on the class (`specialization.ts`), so the
  // site names its own copy exactly as a generic function's call site does.
  const constructedClass = ts.isNewExpression(call) ? constructedGenericClassOf(context, declaration) : null
  if (constructedClass) {
    const site = context.specializations.specializationAt(call, context.types.substituteTypeParameter)
    if (site && site.declaration === constructedClass) {
      const enclosing = context.identities.prefixFor(constructedClass, context.path).filter((step) => step.owner !== constructedClass)
      const copyTypes = context.types.forSpecialization([...enclosing, { owner: constructedClass, ordinal: site.ordinal }])
      // The callee EXPRESSION's own type in that copy, not the constructor's
      // resolved signature: `declaration` here is the CLASS (that is what
      // `new Box(...)`'s callee names), which has no implementation
      // signature of its own, and the class's constructor object read in the
      // copy is exactly the `typeof Box` the ordinary path would have read
      // in the wrong one.
      const constructorSignature =
        declaration && !ts.isClassLike(declaration) ? implementationSignatureOf(context.checker, declaration) : null
      return constructorSignature ? copyTypes.resolvedSignatureTypeOf(constructorSignature, 'construct') : copyTypes.typeAt(node)
    }
  }
  // Overload resolution constrains the expression's result, but the callable
  // still implements its body's one physical frame. Publish that frame here;
  // the existing invocation conversion reconciles it with the selected result.
  const implementation = declaration ? implementationSignatureOf(context.checker, declaration) : null
  if (implementation) {
    // A GENERIC implementation's frame is open, and the view above is the
    // caller's: `some<T>`'s `readonly T[]` read there is the naked hole
    // monomorphization removes, republished at every callee. The copy this
    // call instantiates is the view that binds it -- the specialization
    // census keys the call on the implementation (`specialization.ts`'s
    // `implementationOf`), so the site names the copy and the copy's own
    // substitution closes the frame. A call whose copy was never minted
    // falls back to the checker's instantiated overload, which is closed
    // over the declared overload's frame rather than the body's.
    if ((implementation.getTypeParameters()?.length ?? 0) > 0) {
      const site = context.specializations.specializationAt(call, context.types.substituteTypeParameter)
      if (!site) return calleeTypes.resolvedSignatureTypeOf(signature, ts.isNewExpression(call) ? 'construct' : 'call')
      // A generic METHOD of a generic class is copied per (class copy, method
      // copy): `Box<T>.map<R>` has one body per pair. `prefixFor` can only
      // answer with copies the CALL SITE is inside, which for `s.map(...)`
      // written outside the class is none -- so the method's copy was walked
      // with no class copy under it and `this.value` had `T` unbound. The
      // receiver names the class copy; the site names the method's.
      const enclosing = receiverCopy ?? context.identities.prefixFor(site.declaration, context.path)
      const last = enclosing[enclosing.length - 1]
      const isSelfReference = last !== undefined && last.owner === site.declaration && last.ordinal === site.ordinal
      const copyPath = isSelfReference ? enclosing : [...enclosing, { owner: site.declaration, ordinal: site.ordinal }]
      // The copy is BOTH halves here: the frame is the implementation's and
      // the type arguments are what the copy binds, so the binding path is
      // the copy's own rather than the caller's.
      return context.types
        .forSpecialization(copyPath)
        .resolvedSignatureTypeOf(implementation, ts.isNewExpression(call) ? 'construct' : 'call')
    }
    return calleeTypes.resolvedSignatureTypeOf(implementation, ts.isNewExpression(call) ? 'construct' : 'call')
  }
  // A declaration a host BINDS (`semantics/host-protocols.ts`'s census, read
  // here through `context.hostProtocols`) is a closed, non-generic native
  // protocol -- `Math`, `StringConstructor`, `DateConstructor`, ... -- so its
  // resolved call signature substitutes nothing the plain type does not already
  // state; `deriveShape`'s own `declared`-with-`bound` case
  // (`representation/derive.ts`) reads exactly this plain shape to publish
  // `native-handle`, never the resolved-signature one. Reading the resolved
  // signature back here anyway would lose the one fact the plain type carries
  // that a bare signature cannot: which protocol the declaration is bound to.
  // That loss is not academic -- `String(code)` and `String.fromCharCode(code)`
  // both read the SAME declaration, and `projectBindingPlacements`
  // (`projection/bindings.ts`) places one cell for it from whichever read it
  // sees first. Whichever placement lost, the OTHER read then asks the cell for
  // a load it cannot give. The check is keyed on the PLAIN TYPE AT THE CALLEE
  // NODE and never on the resolved signature's own declaration: a signature is
  // one overload member inside `StringConstructor`, not the `String` binding,
  // so `hostProtocols` -- keyed by binding declaration -- would never match it.
  const plain = calleeTypes.typeAt(node)
  const plainShape = context.table.get(plain).shape
  // An unchecked call placeholder has no declaration and cannot establish
  // that its callee is callable. Preserve the actual value even when it is
  // nullish/non-callable, so the runtime throws instead of boxing it as an
  // invented function with an `any` result.
  if (isFabricatedSignatureShape(context.checker, signature)) return arityResolvedOverload(context, plain, call)
  if (plainShape.kind === 'declared' && context.hostProtocols.has(plainShape.declaration)) return plain
  // A callee bound to ONE physical function but DECLARED with an overloaded
  // type -- `structural-declarations.ts`'s `physicalOverloadTypeAt`, hono's
  // `export const parseBody: ParseBody = async (request, options = ...) =>
  // {...}` being the exact case that showed it apart. `typeAt` (above, as
  // `plain`) already collapses a REFERENCE to such a binding onto the one
  // physical signature the value actually has at runtime -- the same
  // collapse the binding's own CELL uses, so every plain read of `parseBody`
  // agrees. `getResolvedSignature` does not know about that collapse: TS
  // never resolves an external call to an overloaded declaration's
  // implementation signature, only to one of its declared OVERLOAD
  // signatures (`ParseBody`'s `options?: Partial<ParseBodyOptions>` member,
  // here) -- a real, different ABI from the physical function that actually
  // runs. Reading that resolved overload back below would build a callee
  // carrier the binding's own cell disagrees with: two authorities citing
  // the same one-function value, and the checker's is the one with no
  // runtime referent to back it (`request.ts:217`'s stuck
  // binding-read-conversion obligation was exactly this gap). `plain` is
  // already the answer that matches, so prefer it whenever it exists.
  if (plainShape.kind === 'signature' && physicalOverloadTypeAt(context.checker, node) !== null) return plain
  // The same fact one level out, reached through a MEMBER instead of a
  // binding. `Context.text: TextRespond = (text, arg, headers) => {...}`
  // (hono's `context.ts`) annotates the property with an overload set and
  // initializes it with ONE arrow function -- so the class layout stores one
  // physical convention while `getResolvedSignature` hands back whichever
  // declared overload this call site matched. That is not a narrowing of the
  // stored value: overload resolution is a type-level fiction over a single
  // runtime function (ECMA-262 has no notion of overloads at all), and
  // believing it here mints a second callable carrier for a field the layout
  // already spelled -- which is the `field "text" is stored as ... and this
  // read publishes ...` refusal, verbatim, in `emit-properties.ts`.
  //
  // `physicalOverloadTypeAt` already admits `isPropertyDeclaration` and
  // `isPropertyAssignment`; what it never saw was a property ACCESS, because
  // this is the only caller that holds one. So the member's own declaration is
  // resolved and the existing rule is asked about it -- no new rule, and no
  // second opinion about how many conventions one value has.
  //
  // Deliberately NOT a blanket "a member callee publishes its declared type":
  // `arr.map`'s declared type carries an unbound `<U>` that the enclosing call
  // is what commits, and that commitment is real. An overload set is not a
  // commitment -- there is one function either way.
  const physicalMember = physicalMemberOverloadTypeAt(context, node)
  if (physicalMember !== null) return calleeTypes.typeOf(physicalMember)
  // A member reached through a RECEIVER whose type is a parameter this copy
  // binds. TypeScript resolves `operation.weight` on `T`'s apparent type --
  // its CONSTRAINT -- because that is all the language knows about `T` while
  // checking one generic body, so the resolved signature is written over
  // `Operation` however `T` was instantiated. This copy knows more: its
  // receiver really is a `Heavy`, and the member it names is `Heavy`'s own
  // override. Believing the checker here publishes a callee carrier whose
  // receiver is the BASE while the call it accompanies dispatches to the
  // DERIVED body -- `CallableObject<double(Ref<Operation>)>` initialized from
  // `Heavy::weight`'s thunk, two authorities over one value, and clang refuses
  // the pair outright.
  //
  // `typeAt` is the exact answer instead, and not a second opinion: it
  // resolves the member through the receiver's own SUBSTITUTED shape, which is
  // the same walk that chose the derived body. Scoped to a receiver the copy
  // actually binds, so an ordinary member call on a non-generic receiver keeps
  // the checker's answer exactly as before.
  const substitutedMember = substitutedReceiverMemberType(context, node)
  if (substitutedMember !== null) return calleeTypes.typeOf(substitutedMember)
  // A callee the program left `any` (or `unknown`) is the one case where the
  // checker committed to NOTHING and still answers. `getResolvedSignature`
  // returns TypeScript's own `anySignature` there -- a fabricated
  // zero-parameter, `any`-returning signature that stands for "this call was
  // not checked", not for a convention anything has. Interning it produces a
  // callable carrier whose ABI declares no parameters at all, so
  // `fn(a, b, c)` acquires a callee that takes none: preflight cannot classify
  // arguments 0..2 against slots that do not exist, and an emitter that got
  // past it would render a three-argument call through a
  // `CallableObject<Value()>`.
  //
  // The plain type is the honest answer: `any` is `dynamic`, the call is a
  // dynamic call, and `gea::Value::callAsFunction` is what performs it. This
  // is a citation of the same rule the function's own header states -- the
  // resolved signature is read back only where the checker really did commit.
  if (plainShape.kind === 'primitive' && (plainShape.primitive === 'any' || plainShape.primitive === 'unknown')) return plain
  // The same rule, reached by the other road, and the guard above cannot see
  // it. That one asks whether the PLAIN type is `any` -- but the plain type is
  // `context.types.typeAt`, which consults the call-site parameter census, and
  // the census exists precisely to answer where the checker did not. So for a
  // callee whose receiver is an unannotated JS parameter -- three.js's ES5
  // factory modules throughout -- the census hands back the real signature
  // while `getResolvedSignature` still hands back TypeScript's fabricated
  // `anySignature`, the guard above misses, and the fabricated one is interned
  // over the top of the real answer. Two authorities, and the wrong one won.
  //
  // Keyed on the CHECKER's own answer, not on the plain type: "the checker
  // committed to nothing here" is the fact that makes its resolved signature
  // meaningless, and it is exactly the fact the census was built to fill in.
  // The fabrication is identified by what it is -- no declaration, no
  // parameters, `any` return -- rather than by parameter count alone, because
  // a genuinely nullary function has all of those but a declaration.
  //
  // Measured: the three.js app 950 -> 714 mandatory missing obligations, of which the
  // unclassified `conversion-role:invocation:call:argument` bucket 538 -> 237.
  if (isFabricatedAnySignature(context.checker, node, signature) && plainShape.kind === 'signature' && plainShape.call.length > 0) {
    return plain
  }
  // The same fabrication over a callee the program did not declare `any`.
  // TypeScript also declines to check a call whose callee is the global
  // `Function` -- ECMAScript's "some callable, arguments and result unknown"
  // -- and answers with the identical fabricated signature. hono's `compose`
  // is built on exactly that: `middleware: [[Function, unknown], unknown][]`,
  // and `handler(context, () => dispatch(i + 1))` is a two-argument call
  // whose resolved callee declares no parameters at all.
  //
  // Neither guard above can take it: the checker's type is not `any`, and the
  // callee's own shape carries no call signature to prefer over the
  // fabrication -- `Function` declares `apply`/`call`/`bind` and no call
  // signature, so it interns as a record. Interning the fabrication anyway
  // puts a `CallableObject<Value()>` where a two-argument call is, and
  // preflight has no slots to classify the arguments against.
  //
  // `any` is the honest answer, and it is the same one the `any`-callee guard
  // above reaches: the checker committed to nothing, the callee is an
  // arbitrary callable, and what the language performs is a dynamic call.
  if (isFabricatedSignatureShape(context.checker, signature) && !(plainShape.kind === 'signature' && plainShape.call.length > 0)) {
    return context.table.intern({ kind: 'primitive', primitive: 'any' })
  }
  // An optional call's resolved signature carries the chain's `undefined` in
  // its return, which is a fact about the call expression rather than about
  // this callee: the method returns what it declares, and does not run at all
  // on the other branch. Believing the augmented return here would build a
  // callee carrier the real method has no store into.
  const presentReturn = isShortCircuitingCall(call) ? presentReturnTypeOf(context.checker, signature) : undefined
  return calleeTypes.resolvedSignatureTypeOf(signature, ts.isNewExpression(call) ? 'construct' : 'call', presentReturn)
}

export const calleeAwareTypeAt = (context: ProducerContext, node: ts.Expression): StructuralTypeId => {
  const call = enclosingCallIfCallee(node)
  // A callee that is its own call's short-circuit guard keeps its own type.
  // `host.raf?.(cb)` tests `host.raf`, whose value genuinely is `fn |
  // undefined`, and collapsing it to the signature it would have *if it ran*
  // erases the very thing the operator branches on: the presence test then has
  // nothing optional to ask about, folds to a constant `true`, and the call
  // runs unconditionally. The narrowed, callable shape is a fact about the
  // call's own operand -- `resolvedCalleeSignatureType`, which the invocation
  // producer asks for directly -- not about what this expression evaluates to.
  if (call && ts.isCallExpression(call) && call.questionDotToken !== undefined) return context.types.typeAt(node)
  return resolvedCalleeSignatureType(context, node) ?? context.types.typeAt(node)
}

/**
 * Whether a structural type is a plain `T[]`/`Array<T>` -- never a tuple,
 * never a union, never an interned `unresolved`.
 *
 * This is the one predicate that decides whether a spread or a destructuring
 * pattern's source may take the array/string fast path (index reads,
 * `appendRange`) instead of needing the general iterator protocol. A tuple's
 * elements are individually typed and keyed by position, not a single
 * repeated element type, so it is deliberately excluded even though it is
 * also array-shaped at runtime -- `lower-allocation.ts`'s own tuple-vs-array
 * carrier split already draws this exact line, and this predicate answers it
 * from the same source of truth (the interned shape), not a second opinion.
 */
export const isPlainArrayType = (context: ProducerContext, type: StructuralTypeId): boolean => {
  const shape = context.table.get(type).shape
  if (shape.kind === 'array') return true
  // A named array -- `NodeArray<T> extends ReadonlyArray<T>`, whose declared
  // body `structural.ts`'s `arrayHeritageShapeOf` lays out as the array it is
  // -- iterates exactly as the array does: the fields it adds live beside the
  // elements (`gea::ArrayObject::extension`), not in them. Read through the
  // anchor rather than answered `false`, which minted a `get-method` step no
  // manifest claims and refused every `for (const p of parameters)` in tsc.
  if (shape.kind !== 'declared' || shape.body === null) return false
  return context.table.get(shape.body).shape.kind === 'array'
}

/**
 * The members an object spread copies, when the source's own-property set is
 * statically known -- or the reason it is not.
 *
 * `{ ...a }` is `CopyDataProperties` (ECMA-262 7.3.25) over the source's OWN
 * ENUMERABLE properties, and for a data-only object shape that set is exactly
 * its members. This is the one authority on when that holds, asked by BOTH
 * halves that must agree about it: `producers/allocations.ts` copies the
 * members field by field, and `producers/protocol.ts` publishes its generic
 * `spread` protocol operation only when this says no -- the same bypass shape,
 * and for the same reason, that `isPlainArrayType` gives an array-literal
 * spread. Two independent predicates here would let one half copy the fields
 * while the other published a protocol step nothing lowers.
 *
 * A named interface interns as `declared` around its body; the BODY carries the
 * members, so one level is unwrapped. Every other shape -- and every member
 * this cannot copy correctly -- answers with a reason instead:
 *
 *  - an INDEX SIGNATURE: the own-property set is not known until runtime, and
 *    copying only the declared members would silently drop the rest;
 *  - an ACCESSOR: `{ ...o }` copies a getter's RETURNED value, so it must be
 *    called, which is user code this layer does not invoke;
 *  - a `signature`-shaped member: a method on a class instance lives on the
 *    prototype and is not own-enumerable at all, and the shape alone cannot
 *    tell that from an own function-valued field;
 *  - `membersDropped`: a projection already filtered this body, so its member
 *    list is not the source's own-property set (see `representation/object-shape.ts`);
 *  - a SYMBOL key: `CopyDataProperties` skips a non-enumerable one, and the
 *    shape does not record enumerability.
 */
export const staticSpreadMembersOf = (
  context: ProducerContext,
  type: StructuralTypeId
): { readonly members: readonly StructuralMember[] } | { readonly blocked: string } => {
  const outer = context.table.get(type).shape
  const shape = outer.kind === 'declared' && outer.body !== null ? context.table.get(outer.body).shape : outer
  // `...(parsed ? { resolutionMode: parsed } : {})` (tsc's parser.ts, and an
  // idiom everywhere): the source is a UNION of object literals, and the
  // checker has already normalized it so every arm carries every key --
  // `{ resolutionMode: string } | { resolutionMode?: undefined }`. Whichever
  // arm is live, `CopyDataProperties` copies that arm's own members, so the
  // union's static member set is the union of the arms': a key every arm
  // states with one type keeps it, a key whose arms disagree reads as the
  // union of their types, and a key some arm lacks is optional and carries
  // `undefined` for that arm. Every arm is held to the same conditions as a
  // lone object source; one arm this cannot copy blocks the whole spread.
  if (shape.kind === 'union') {
    const merged = new Map<
      string,
      { readonly member: StructuralMember; readonly types: StructuralTypeId[]; optional: boolean; seen: number }
    >()
    const arms: (readonly StructuralMember[])[] = []
    for (const arm of shape.members) {
      const admitted = staticSpreadMembersOf(context, arm)
      if ('blocked' in admitted) return admitted
      arms.push(admitted.members)
    }
    for (const members of arms) {
      for (const member of members) {
        if (member.key.kind === 'symbol') continue
        const key = String(member.key.value)
        const entry = merged.get(key)
        if (entry === undefined) {
          merged.set(key, { member, types: [member.type], optional: member.optional, seen: 1 })
          continue
        }
        if (!entry.types.includes(member.type)) entry.types.push(member.type)
        entry.optional ||= member.optional
        entry.seen += 1
      }
    }
    const undefinedType = context.table.intern({ kind: 'primitive', primitive: 'undefined' })
    const members: StructuralMember[] = []
    for (const entry of merged.values()) {
      const absentSomewhere = entry.seen < arms.length
      const types = absentSomewhere && !entry.types.includes(undefinedType) ? [...entry.types, undefinedType] : entry.types
      const sole = types.length === 1 ? types[0] : undefined
      const memberType = sole ?? context.table.intern({ kind: 'union', members: types })
      members.push({ ...entry.member, type: memberType, optional: entry.optional || absentSomewhere })
    }
    return { members }
  }
  if (shape.kind !== 'object') {
    return { blocked: `an object spread of a "${shape.kind}"-shaped source has no statically known own-property set` }
  }
  if (shape.membersDropped) {
    return { blocked: "an object spread of a projected (data-only) body cannot state the source's own-property set" }
  }
  if (shape.index.length > 0) {
    return { blocked: 'an object spread of a source with an index signature needs the runtime own-property enumeration' }
  }
  for (const member of shape.members) {
    const key = member.key.kind === 'symbol' ? `symbol ${member.key.declaration}` : String(member.key.value)
    if (member.accessor !== null) {
      return { blocked: `an object spread of a source with the accessor "${key}" must call it, which is not modelled` }
    }
    if (context.table.get(member.type).shape.kind === 'signature') {
      return {
        blocked:
          `an object spread of a source whose member "${key}" is callable cannot tell an own function-valued field ` +
          'from a prototype method, and only the first is copied'
      }
    }
    if (member.key.kind === 'symbol') {
      return { blocked: `an object spread of a source with the symbol-keyed member "${key}" needs its enumerability` }
    }
  }
  return { members: shape.members }
}

/**
 * Whether a structural type is the standard `Set<T>` -- the second source
 * whose iteration needs no dynamic `@@iterator` lookup.
 *
 * The sibling of `isPlainArrayType` above, answering the same question about a
 * shape whose answer is a DECLARATION identity rather than a shape kind. It
 * reads `context.keyedCollections`, the frontend's one census
 * (`host-protocols.ts`'s `keyedCollectionDeclarationsOf`), which is also what
 * `representation/derive.ts` selects the collection carrier from -- so the
 * producer's "skip the method lookup" decision and the carrier's "this is a
 * `keyed-collection`" decision can never be made about different declarations.
 *
 * `'set'` ONLY -- `isNativeIterableMapType` below answers the Map half, which
 * needs a different fact from the carrier side and so cannot share one
 * predicate. The weak families have no iteration at all (ECMA-262 24.3/24.4)
 * and are covered by neither.
 */
export const isNativeIterableSetType = (context: ProducerContext, type: StructuralTypeId): boolean => {
  const shape = context.table.get(type).shape
  return shape.kind === 'declared' && context.keyedCollections.get(shape.declaration) === 'set'
}

/**
 * Whether a structural type is the standard `Map<K, V>` -- the fourth source
 * whose iteration needs no dynamic `@@iterator` lookup, and the only one whose
 * element is not storage the source already holds.
 *
 * ECMA-262 24.1.5.1 `%MapIteratorPrototype%.next` yields a `[K, V]` PAIR, and
 * this compiler carries a tuple as a record of "0"/"1" fields. That is why the
 * decision has two halves that must agree: this one, which says the census may
 * skip the method lookup, and `representation/publish.ts`'s
 * `nativeCursorIteratorOf`, which must be able to publish a cursor over the
 * pair's own carrier. The carrier side is the stricter of the two -- it reads
 * the pair's record layout back out of the iterator record's declared element
 * type and refuses unless the fields really are "0"/"1" carrying the
 * collection's own key and value -- so a Map whose pair this compiler cannot
 * lay out publishes no cursor, keys as the unclaimed
 * `protocol:iterator:next:record`, and refuses at preflight. Skipping the
 * method lookup for it is therefore safe in the one direction that matters:
 * it can only ever cost a refusal, never a wrong lowering.
 */
export const isNativeIterableMapType = (context: ProducerContext, type: StructuralTypeId): boolean => {
  const shape = context.table.get(type).shape
  return shape.kind === 'declared' && context.keyedCollections.get(shape.declaration) === 'map'
}

/** A `Map.prototype.entries()` result is already the native pair cursor. */
const isNativeMapIteratorType = (context: ProducerContext, type: StructuralTypeId): boolean => {
  const shape = context.table.get(type).shape
  return shape.kind === 'declared' && shape.declaration === context.mapIteratorDeclaration
}

/**
 * Whether a structural type is a `string` -- the third source whose iteration
 * needs no dynamic `@@iterator` lookup.
 *
 * ECMA-262 22.1.3.36 `String.prototype[@@iterator]` walks the receiver by CODE
 * POINT, and a String is an immutable primitive, so the step sequence is fixed
 * the moment the loop starts: there is nothing for `GetIterator` to resolve
 * that the value itself does not already answer. `gea::Iterator<std::string>`'s
 * string source (`runtime/gea_runtime.h`) is that walk.
 *
 * Deliberately narrower than "everything that CARRIES as `string`": a union of
 * string literals collapses to the `string` carrier in `derive.ts`, and this
 * answers `false` for it. That asymmetry is safe in exactly one direction --
 * `publish.ts` would publish the cursor, this producer would still mint the
 * `get-method` step, and `protocol:iterator:get-method:string` is claimed by no
 * manifest, so the program refuses at preflight by name. The reverse (claiming
 * the fast path for a shape whose carrier is not `string`) would emit a
 * constructor call that does not exist, so the predicate is written to fail in
 * the safe direction rather than to re-derive `deriveUnion`'s collapse rule as
 * a second authority.
 */
export const isNativeIterableStringType = (context: ProducerContext, type: StructuralTypeId): boolean => {
  const shape = context.table.get(type).shape
  if (shape.kind === 'primitive') return shape.primitive === 'string'
  return shape.kind === 'literal' && shape.primitive === 'string'
}

/**
 * Whether a source is a tuple with a fixed arity -- every element at a known
 * position, none of them rest or variadic.
 *
 * A tuple IS an Array at runtime, so `for (const x of ['a', 'b'] as const)` is
 * ordinary TypeScript that every JavaScript engine iterates through
 * `Array.prototype[Symbol.iterator]`. This compiler carries a tuple as "a
 * record whose keys are its indices" (`derive.ts`'s `deriveTuple`), which has
 * no `@@iterator` FIELD, so the general dynamic protocol correctly refused
 * every such loop -- nine of them in the mongodb driver alone, each over a
 * `const [...] as const` option list.
 *
 * A fixed arity is what makes the walk settled: the elements are the record's
 * own fields, in order, known before the program runs. Whether they also share
 * ONE element carrier is a question about representations, which this layer
 * cannot ask -- `preflight/runtime-helper-key.ts`'s `iteratorMethodCarrierKind`
 * refines the carrier per site and leaves a heterogeneous tuple on an
 * unclaimed key, so it refuses at preflight rather than reaching an emitter
 * with nothing to build.
 */
export const isFixedArityTupleType = (context: ProducerContext, type: StructuralTypeId): boolean => {
  const shape = context.table.get(type).shape
  return shape.kind === 'tuple' && shape.elements.every((element) => !element.rest && !element.variadic)
}

/**
 * A tuple with a `rest` position and no variadic one -- `[A, ...B[]]`. Its
 * carrier is an ARRAY (`representation/derive.ts`'s `deriveTuple`: the array
 * carrier over the union of its positions), so iterating it is the array's
 * own native cursor, the same one a plain `T[]` has.
 */
export const isOpenTupleType = (context: ProducerContext, type: StructuralTypeId): boolean => {
  const shape = context.table.get(type).shape
  return shape.kind === 'tuple' && shape.elements.some((element) => element.rest) && !shape.elements.some((element) => element.variadic)
}

/**
 * Whether a source's iteration is settled before the program runs -- an
 * `array`, a `Set<T>`, a `Map<K, V>`, a `string`, a `Generator<T, ...>`, a
 * fixed-arity tuple, or a union whose every present arm is one of those.
 *
 * The ONE predicate every consumer of the native iterator cursor asks, so that
 * `for`-`of` (`control.ts`), array-literal spread (`allocations.ts`),
 * call-argument spread (`spread-arguments.ts`, `protocol.ts`) and array
 * destructuring (`destructuring.ts`) can never disagree about which sources it
 * covers. They did disagree before it existed: a `for`-`of` over a `Set` took
 * the fast path while `[...set]` in the same program minted a `get-method`
 * step for the identical value and refused.
 */
/**
 * The one PRESENT arm of a union whose only other arms are absent -- `T[] |
 * undefined`, `Set<T> | null` -- or `null` for every other shape.
 *
 * Iterating an absent value is a runtime `TypeError` in ECMA-262 (7.4.2
 * `GetIterator` calls `GetMethod` on `undefined`, which throws), never a
 * static impossibility, so `T[] | undefined` iterates through exactly the
 * cursor `T[]` does with a presence assertion in front of it. The ONLY thing
 * absence changes is whether the walk starts.
 *
 * That distinction is the reason this looks through the wrapper rather than
 * `hasNativeIterationCursor` growing an arm per absent-shaped source: the
 * cursor, its element and every capability claim behind it are the payload's,
 * and the absence is a separate, single fact the backend spells once
 * (`targets/cpp/emit-iterator.ts`'s presence assertion) for whichever payload
 * shape it wraps.
 *
 * Exactly one present arm, deliberately. Two would be a real union needing a
 * discriminated walk -- a question about representations this layer cannot
 * ask -- and zero is `never`, which iterates nothing.
 */
export const presentIterationArm = (context: ProducerContext, type: StructuralTypeId): StructuralTypeId | null => {
  const shape = context.table.get(type).shape
  if (shape.kind !== 'union') return null
  const present: StructuralTypeId[] = []
  for (const member of shape.members) {
    const arm = context.table.get(member).shape
    if (arm.kind === 'primitive' && (arm.primitive === 'undefined' || arm.primitive === 'null')) continue
    present.push(member)
  }
  const only = present.length === 1 ? present[0] : undefined
  return only !== undefined && present.length < shape.members.length ? only : null
}

export const hasNativeIterationCursor = (context: ProducerContext, type: StructuralTypeId): boolean => {
  if (
    isPlainArrayType(context, type) ||
    isNativeIterableSetType(context, type) ||
    isNativeIterableMapType(context, type) ||
    isNativeIterableStringType(context, type) ||
    isGeneratorType(context, type) ||
    isNativeMapIteratorType(context, type) ||
    isFixedArityTupleType(context, type) ||
    isOpenTupleType(context, type)
  ) {
    return true
  }
  // An absent source does not lose the cursor its payload has; see
  // `presentIterationArm`. Asked here, in THE predicate every consumer of the
  // native cursor shares, so `for`-`of`, spread and array destructuring can no
  // more disagree about `T[] | undefined` than they can about a bare `Set`.
  const payload = iterationPayloadArm(context, type)
  if (payload !== null) return hasNativeIterationCursor(context, payload)
  // Every present arm is an array, though not the same one: `name.elements`
  // over `ObjectBindingPattern | ArrayBindingPattern` is `NodeArray<
  // BindingElement> | NodeArray<ArrayBindingElement>`. Whether those are one
  // carrier is the deriver's question, not this one's: when the element
  // layouts agree (tsc's `Node` family is ONE layout) it collapses the union
  // to one `array-object`, and answering "no cursor" here minted a
  // `get-method` step no manifest claims -- 19 `for (const element of
  // name.elements)` rows on the self-compile. When they do not agree the
  // carrier is a tagged union, and the native path refuses that BY NAME at
  // the manifest (`get-iterator:tagged-union`), so saying "cursor" never
  // certifies a discriminated walk this backend has not built.
  const arms = presentUnionArms(context, type)
  if (arms === null) return false
  if (arms.every((arm) => isPlainArrayType(context, arm))) return true
  // Every present arm a FIXED-ARITY TUPLE -- hono's `Result<T> = [[T,
  // ParamIndexMap][], ParamStash] | [[T, Params][]]`, whose `.map` callback
  // binds `[T, ParamIndexMap] | [T, Params]`. Each arm's shape is closed and
  // known at compile time, which is the whole of what "settled before the
  // program runs" asks, so the union is as settled as the lone tuple two
  // lines up: `ir/lower-destructuring.ts`'s `isTupleUnionCarrier` already
  // reads position `i` off whichever arm is live, with no iterator record in
  // between. Answering "no cursor" here sent the pattern through the general
  // protocol instead, and its element steps then read position 0 of the
  // ITERATOR RECORD the protocol published -- a `record` whose layout has no
  // field keyed "0", which is how `request.ts`'s `routePath` refused.
  // A union mixing arms of different KINDS stays false: the carrier is a
  // tagged union the native path refuses by name, exactly as above.
  return arms.every((arm) => isFixedArityTupleType(context, arm))
}

const presentUnionArms = (context: ProducerContext, type: StructuralTypeId): readonly StructuralTypeId[] | null => {
  const shape = context.table.get(type).shape
  if (shape.kind !== 'union') return null
  const present: StructuralTypeId[] = []
  for (const member of shape.members) {
    const arm = context.table.get(member).shape
    if (arm.kind === 'primitive' && (arm.primitive === 'undefined' || arm.primitive === 'null')) continue
    present.push(member)
  }
  return present.length > 1 ? present : null
}

/**
 * A union with exactly one DISTINCT present arm is that arm.
 *
 * `presentIterationArm` answers only the absence-wrapped shape, and refuses a
 * union it removed nothing from. A union the checker built from a property
 * read over a union receiver -- `name.elements` over `ObjectBindingPattern |
 * ArrayBindingPattern` -- interns to a one-member union when the arms intern
 * alike, a shape `isPlainArrayType` does not see through, and the refused rows
 * read `protocol:iterator:get-method:array-object`: an operand the deriver
 * had called one array while this predicate had called a union.
 *
 * Exactly one distinct arm, deliberately, and NOT "every arm is an array":
 * two arrays over different elements are two C++ carriers, the union of them
 * is a tagged union, and iterating it is a discriminated walk this backend
 * has not built -- that source reaches the manifest under
 * `get-iterator:tagged-union`, which nothing claims, and refuses there by
 * name. Saying "cursor" for it here would only move the same refusal.
 */
const soleDistinctPresentArm = (context: ProducerContext, type: StructuralTypeId): StructuralTypeId | null => {
  const shape = context.table.get(type).shape
  if (shape.kind !== 'union') return null
  const present = new Set<StructuralTypeId>()
  for (const member of shape.members) {
    const arm = context.table.get(member).shape
    if (arm.kind === 'primitive' && (arm.primitive === 'undefined' || arm.primitive === 'null')) continue
    present.add(member)
  }
  const [only, ...rest] = present
  return only !== undefined && rest.length === 0 ? only : null
}

/**
 * The type an iteration actually reads FROM, once a union that names one real
 * iterable has been peeled to it.
 *
 * ONE authority, because two questions are asked about this same peeled type
 * and they must not be able to disagree: `hasNativeIterationCursor` below asks
 * whether it has a native cursor, and `producers/protocol.ts`'s
 * `iterationElementType` asks what that cursor yields. Those are the two
 * callers, and they are the only two.
 *
 * They HAD disagreed, in three different spellings of the same peel:
 * `presentIterationArm` answers only when something nullish was actually
 * removed, `soleDistinctPresentArm` dedupes members first, and
 * `iterationElementType` carried a third, inline copy that did neither. A
 * union whose arms intern to ONE id (`NodeArray<BindingElement> |
 * NodeArray<ArrayBindingElement>`, tsc's `Node` family being one layout) is
 * peeled by the deduping spelling and not by the inline one -- so the cursor
 * predicate said "native cursor, no dynamic `Symbol.iterator` lookup needed"
 * while the element reader fell through to the checker walk and refused with
 * `the source declares no @@iterator/next/IteratorResult chain this can read
 * an element type from`. That is `nested-array-assignment-pattern.runtime.js`'s
 * for-`of` arm: a certified cursor whose element type nothing could state.
 *
 * Returns `null` when the type is not such a union at all -- the caller then
 * uses the type it already had, which is what both callers did before.
 */
export const iterationPayloadArm = (context: ProducerContext, type: StructuralTypeId): StructuralTypeId | null => {
  const nullishPeeled = presentIterationArm(context, type) ?? soleDistinctPresentArm(context, type)
  if (nullishPeeled !== null) return nullishPeeled
  // SEVERAL present arms, exactly ONE of them iterable. `[, [g, h]] = pair`
  // over an untyped `var pairs = [[1, [2, 3]], ...]` reads a position typed
  // `number | number[] | undefined`: peeling the nullish arm still leaves two,
  // so the spellings above decline -- and every shape check downstream then
  // fails to recognize `union` at all.
  //
  // The representation and IR layers already committed to reading that one
  // arm: `representation/publish.ts`'s `patternSourceArmOf` publishes
  // `soleArrayPatternCapableArm`, and `ir/lower-destructuring.ts` emits the
  // `require-tagged-union-arm` guard that makes the read sound at runtime.
  // Answering `null` here left the two halves disagreeing in the worst
  // direction: the element type refused, and once it did not, the cursor
  // predicate still said "no native cursor" and minted a fully dynamic
  // `get-method` step that no IR primitive lowers. One arm, one answer, both
  // callers.
  //
  // Strictly one: two iterable arms is a real question about which applies,
  // and the caller's own refusal stays the honest answer. Recursion through
  // `hasNativeIterationCursor` terminates because a union's members are
  // interned flattened, so an arm is never the union it came from.
  const shape = context.table.get(type).shape
  if (shape.kind !== 'union') return null
  const iterable = new Set(shape.members.filter((member) => hasNativeIterationCursor(context, member)))
  const [only, ...rest] = iterable
  return only !== undefined && rest.length === 0 ? only : null
}

/**
 * Whether an object body's own member list is a COMPLETE, safe field-name
 * snapshot -- the one question every branch of `hasNativeEnumerationCursor`
 * below asks once it has a body to look at.
 *
 * Two shapes of MEMBER LOSS have to be refused, because either one would make
 * a static field-name walk enumerate fewer keys than the value actually has
 * -- a silently WRONG answer once compiled and run, not a crash:
 *
 *  - `membersDropped`: `structural.ts`'s own `MemberMode` filtering (an
 *    ambient/host declaration's methods, or an object-literal anchor's own
 *    callable members) already dropped some of the type's own properties
 *    from this body before it ever reached here, so the compile-time field
 *    list this walk would build is incomplete by construction.
 *  - an ACCESSOR member: `representation/derive.ts`'s `recordFieldsOf` filters
 *    `member.accessor !== null` out of the record's own `fields` (a getter's
 *    value must be CALLED, which `records.ts`'s static dispatcher does not
 *    do), so a getter's key would silently vanish from the enumeration the
 *    same way a dropped method's would.
 *
 * A SYMBOL-keyed member needs no such exclusion: ECMA-262 14.7.5.9
 * `EnumerateObjectProperties` walks STRING keys only, so a symbol member is
 * correctly invisible to `for`-`in` regardless of whether the static
 * dispatcher lists it. A body with zero members (after the dictionary case
 * above has already claimed the one shape that means) is a legitimate,
 * trivially-complete snapshot -- an empty record enumerates no keys, which is
 * exactly right, not a reason to refuse.
 */
const isCompleteRecordBody = (body: Extract<StructuralShape, { kind: 'object' }>): boolean =>
  !body.membersDropped && body.members.every((member) => member.accessor === null)

/**
 * Whether a `for`-`in` over this source enumerates one of the NATIVE cursors
 * `targets/cpp/emit-iterator.ts` renders: a runtime key TABLE
 * (`gea::Dictionary<V>`), a STATIC field-name snapshot built from a
 * statically shaped receiver's own compile-time member set
 * (`emitStaticEnumerateIterator`, over `gea::nativeDynamicKeys`), or a
 * genuinely DYNAMIC receiver's real own-enumerable-key walk
 * (`emitDynamicEnumerateIterator`, over `Value::ownEnumerableStringKeys`).
 *
 * The enumerate sibling of `hasNativeIterationCursor`, and the same kind of
 * fact for the first two: the keys are storage the receiver already holds
 * (a runtime table, or a compile-time field list), so `for (const k in t)`
 * needs no `[[OwnPropertyKeys]]` machinery and no dynamic protocol.
 *
 * The dictionary test mirrors `representation/object-shape.ts`'s
 * `dictionaryIndexOf` exactly -- no members, exactly one index signature,
 * string-keyed -- because the two have to agree: this decides the LOOP SHAPE
 * and that decides the CARRIER, and a loop reshaped for a cursor the deriver
 * then does not produce would refuse with a key naming neither. It is a
 * structural test rather than a call into `representation/`, which normalize
 * runs before and must not depend on -- `producer-context.ts`'s own doc says
 * as much: a question this predicate cannot answer from the sealed structural
 * table alone needs a NEW primitive threaded onto `ProducerContext`, never a
 * second derivation of a representation-layer policy.
 *
 * A NAMED type (`'declared'`: an interface or type alias) COULD be
 * intercepted by a declaration-identity policy in `representation/derive.ts`
 * before ever reaching a plain `record`/`record-with-index` carrier --
 * `Date`, `RegExp`, `Promise`, a data-only host-bound plugin struct via
 * `nativeTypes` (`GeaEmbeddedImage`, `FetchResponse`, ...) -- and none of
 * those policies' censuses (`DateDeclarationPolicy`, `RegExpDeclarationPolicy`,
 * the host binding table, ...) are threaded onto `ProducerContext`, so this
 * predicate cannot ask the identity question `derive.ts` asks and get the
 * same answer; it can only ask the STRUCTURAL question (is the body a
 * complete record) that `object-anchor` and bare `'object'` already answer
 * below. The host-binding case is the one that matters: `derive.ts`'s own
 * `'declared'` case hardcodes `{ kind: 'native-record-ref', ownership:
 * 'owned', native: bound.native }` for a data-only bound type -- the EXACT
 * `native !== null` combination `emitStaticEnumerateIterator` refuses -- and
 * it shares its `.kind` (`'native-record-ref'`) with the safe,
 * compiler-defined case (a plain interface derives the identical kind with
 * `native: null`), so a carrier-kind obligation keyed only on `.kind` cannot
 * tell the two apart. That is not a reason to keep `'declared'` OUT of this
 * widening, though -- it is a reason the DISTINGUISHING question has to be
 * asked somewhere that still has the full representation to inspect.
 * `'declared'` is therefore treated exactly like `object-anchor` below (both
 * unwrap to their body and take the identical dictionary/record checks), and
 * the host-bound sub-case is caught downstream instead, at preflight:
 * `runtime-helper-key.ts`'s `enumerateGetIteratorCarrierKind` re-resolves the
 * `get-iterator` target's own representation (not just its bare kind, which
 * is all this structural predicate has) and reports a host-bound
 * `native-record-ref` under its own, deliberately unclaimed key --
 * `native-record-ref(host-bound)` -- the same "refine the receiver key" move
 * `preflight/property-access.ts`'s `nativeRecordRefHasIndexSidecar` makes for
 * a `native-record-ref` property read. So a host-bound `for`-`in` is still
 * refused by NAME, still at preflight, still before either loop shape is
 * lowered -- it is just a different file that owns the distinction, because
 * that file is the one still holding the representation once normalize's own
 * structural view of it has been discarded.
 *
 * A compiler-defined CLASS instance (`'class-instance'` with a non-null
 * `body`) does not share that risk, for a reason specific to it:
 * `derive.ts`'s `'class-instance'` case checks the SAME host-binding census
 * before ever looking at `shape.body`, but a bound class -- data-only or not
 * -- resolves to a DIFFERENT kind there, `native-handle`, never `class-ref`;
 * there is no shared-kind trap for the carrier-kind obligation to miss. And
 * `class-ref`'s ownership is never the value-record `'owned'` override either
 * -- `compiler.ts`'s own policy only overrides `shape.kind === 'object'`,
 * never `'class-instance'` -- so it is always `shared-refcount`. A bound
 * class is caught cleanly (unclaimed `native-handle` key); an unbound one is
 * exactly the `class-ref` `emitStaticEnumerateIterator` renders.
 *
 * `'object'` (bare, or unwrapped from a callable-bearing object-literal
 * anchor) needs none of that caution either: it names no declaration a policy
 * could intercept by identity, so a plain, non-generic `record`/
 * `record-with-index` is the only carrier `derive.ts`'s `deriveObject` can
 * ever produce for it.
 */
export const hasNativeEnumerationCursor = (context: ProducerContext, type: StructuralTypeId): boolean => {
  const shape = context.table.get(type).shape
  // `any`/`unknown`, never narrowed: the one genuinely DYNAMIC receiver this
  // enumeration protocol admits (see `emitDynamicEnumerateIterator`'s own
  // header comment in `emit-iterator.ts`) -- a real runtime walk of the box's
  // own enumerable keys, with no compile-time key set to state at all, and no
  // declaration for a policy to have intercepted by identity.
  if (shape.kind === 'primitive' && (shape.primitive === 'any' || shape.primitive === 'unknown')) return true
  // A compiler-defined class instance -- see this function's own doc for why
  // this is safe where a named `'declared'` type is not. `class-ref` is
  // claimed regardless of the body's member/index shape (unlike the object
  // path below, which has a distinct `dictionary` carrier to consider), so
  // this only has to ask whether the field snapshot would be complete.
  if (shape.kind === 'class-instance' && shape.body !== null) {
    const classBody = context.table.get(shape.body).shape
    return classBody.kind === 'object' && isCompleteRecordBody(classBody)
  }
  // A named interface/type-alias (`'declared'`) and a callable-bearing object
  // literal (`object-anchor`) both hold their body behind an id, and
  // `derive.ts` routes both through the identical dictionary/sidecar check on
  // it -- so the body is what the DICTIONARY test and the RECORD test below
  // both ask about, exactly as the deriver does for either shape. `'declared'`
  // is unwrapped and widened past the dictionary test the same way
  // `object-anchor` already is -- see this function's own doc for where the
  // one case that widening is unsafe for (a host-bound `native-record-ref`)
  // is caught instead.
  const body =
    shape.kind === 'declared' || shape.kind === 'object-anchor' ? (shape.body === null ? null : context.table.get(shape.body).shape) : shape
  if (!body || body.kind !== 'object') return false
  const [only] = body.index
  if (body.members.length === 0 && body.index.length === 1 && only !== undefined) {
    // A string table yields its keys. A symbol table also has a complete
    // native answer: zero keys, because EnumerateObjectProperties excludes
    // symbols. Numeric tables remain refused until their ToString ordering is
    // represented exactly rather than falling through as a generic record.
    return only.key === 'string' || only.key === 'symbol'
  }
  return isCompleteRecordBody(body)
}

/**
 * Whether a structural type is the standard `Generator<T, TReturn, TNext>` --
 * what a `function*` returns, and the fifth source with no `@@iterator` lookup
 * behind it.
 *
 * A generator IS its own iterator: ECMA-262 27.5.1.2
 * `%GeneratorPrototype%[@@iterator]` returns `this`, so `GetIterator` over one
 * resolves to the value already in hand and there is nothing dynamic to look
 * up. `representation/derive.ts`'s `GeneratorDeclarationPolicy` carries it as
 * the same `iterator(T)` cursor for exactly that reason -- one value, one
 * carrier, whether it is being called or being walked.
 *
 * Keyed on the declaration the frontend resolved, never on the name, for the
 * reason `isNativeIterableSetType` states about `Set`: the deriver reads the
 * SAME identity, so the two cannot disagree about which declaration is meant.
 */
export const isGeneratorType = (context: ProducerContext, type: StructuralTypeId): boolean => {
  const shape = context.table.get(type).shape
  if (shape.kind !== 'declared') return false
  const generators = [context.generatorDeclaration, context.asyncGeneratorDeclaration]
  return generators.some((declaration) => declaration !== null && shape.declaration === declaration)
}

/**
 * The canonical *static* key text a bracketed key expression resolves to when
 * it names a `unique symbol`, or `null` when it does not.
 *
 * `this[GEA_STATIC_ELEMENT]` is not a dynamic property access. The checker
 * resolves it to a declared member exactly as it resolves `this.rendered`: a
 * `unique symbol` is a compile-time identity, `class C { [S]: T }` declares a
 * member named by it, and `keyof C` includes it. So the key here is static in
 * the only sense this layer's `computed` flag means -- "the key resolved to a
 * constant text" -- which is already why `o["0"]` and `o[0]` are reported
 * non-computed despite being written in brackets.
 *
 * The text is `structural-types.ts`'s `symbolPropertyKeyText`, which is also
 * what `representation/object-shape.ts` names the record field by, so the
 * access and the layout cannot disagree about which member is meant. The
 * `unique-symbol` shape is read back out of the interned table rather than
 * asked of the checker a second time: `structural.ts` already resolved the
 * declaration anchor (and already answered `unresolved` for a symbol that has
 * none), and a second resolution here would be a second authority over one
 * fact.
 */
export const uniqueSymbolKeyTextOf = (context: ProducerContext, type: StructuralTypeId): string | null => {
  const shape = context.table.get(type).shape
  return shape.kind === 'unique-symbol' ? symbolPropertyKeyText(shape.declaration) : null
}

/** The shared layout fact that requires retaining a symbol's evaluated identity. */
export const isRuntimeSymbolMember = (context: ProducerContext, receiver: StructuralTypeId, keyType: StructuralTypeId): boolean => {
  const key = context.table.get(keyType).shape
  if (key.kind !== 'unique-symbol') return false
  const visited = new Set<StructuralTypeId>()
  let current = receiver
  while (!visited.has(current)) {
    visited.add(current)
    const shape = context.table.get(current).shape
    if (shape.kind === 'object') return runtimeSymbolMemberIndexOf(shape, { kind: 'symbol', declaration: key.declaration }) !== null
    if ((shape.kind === 'declared' || shape.kind === 'object-anchor') && shape.body !== null) current = shape.body
    else if (shape.kind === 'intersection' && shape.resolved !== null) current = shape.resolved
    else return false
  }
  return false
}

/**
 * `ToPropertyKey` of a key whose value is fixed at compile time, or `null` when
 * it is not.
 *
 * `{ [K]: v }` is not a dynamic property definition when `K`'s *type* pins the
 * key: the checker itself types `{ [K]: 1 }` as `{ a: number }` for
 * `const K = 'a'`, lists `a` in `keyof`, and resolves `o.a` against it. So the
 * key is static in the only sense this layer's `computed` flag means -- the
 * same sense in which `o["0"]` and `o[0]` are already reported non-computed --
 * and lowering it as anything else would put a member the layout declares into
 * a dictionary the layout does not have.
 *
 * The answer is read out of the interned shape rather than off the key's
 * syntax, which is what makes `const K = 'a'` and `'a'` one case: a
 * declaration's literal type is exactly as fixed as a literal written in place,
 * and `structural-leaves.ts` has already interned both as the same shape.
 * Reading syntax would see two different programs.
 *
 * Every literal shape resolves, because ECMA-262 7.1.19 `ToPropertyKey` is
 * total over them and `structural-leaves.ts` already interned each one's text
 * in the exact spelling `ToString` produces: a number through `String(value)`
 * (which is `Number::toString`, and answers `"0"` for `-0` as the language
 * does), a bigint in decimal, a boolean as `"true"`/`"false"`. A `unique
 * symbol` needs no `ToString` at all -- it is already a property key -- and
 * shares `uniqueSymbolKeyTextOf`'s spelling so a computed definition and a
 * `receiver[K]` read name one member.
 */
export const staticPropertyKeyTextOf = (context: ProducerContext, type: StructuralTypeId): string | null => {
  const shape = context.table.get(type).shape
  if (shape.kind === 'unique-symbol') return symbolPropertyKeyText(shape.declaration)
  return shape.kind === 'literal' ? shape.text : null
}

/**
 * The static member key `receiver[SOME_SYMBOL]` names, or `null` when the
 * access is not a declared-member read at all.
 *
 * This is the whole difference between two accesses that look identical:
 *
 *   this[GEA_STATIC_ELEMENT]                       // a declared class member
 *   (obj as Record<symbol, unknown>)[GEA_DIRTY]    // an index signature
 *
 * The first is a struct member load with a compile-time name -- the checker
 * resolves it to a declared member exactly as it resolves `this.rendered`. The
 * second is a genuine dynamic-table lookup keyed by the symbol's RUNTIME
 * value, and spelling it as a static text would file it under the string half
 * of the object's key space, where `Object.keys` would list a property whose
 * whole purpose is not being enumerated.
 *
 * The RECEIVER'S MEMBER LIST decides, and it is asked of the checker rather
 * than of the already-interned shape: `structural.ts` interns some bodies
 * data-only (its `MemberMode`), so a symbol-named METHOD -- which
 * `this[GEA_STATIC_TEMPLATE]()` is -- is absent from the interned body while
 * being a perfectly ordinary declared member. Reading the interned body would
 * therefore answer "dynamic" for a member the class really declares.
 *
 * Matching is by DECLARATION IDENTITY, never by spelling:
 * `symbolKeyDeclarationOf` resolves a member's key to the `const` the symbol
 * was bound to, which is the identical anchor `structural.ts`'s
 * `UniqueESSymbol` branch gives the key expression's own type, so the two
 * sides compare one fact.
 */
export const symbolMemberKeyOf = (context: ProducerContext, receiver: ts.Expression, keyType: StructuralTypeId): string | null => {
  const key = context.table.get(keyType).shape
  if (key.kind !== 'unique-symbol') return null
  if (isRuntimeSymbolMember(context, context.types.typeAt(receiver), keyType)) return null
  // HOLDS: the receiver's own member list, read the census-aware way
  // (`context.types.rawTypeAt`) so an under-typed receiver the census
  // resolved to a real class does not silently fail this symbol-member match.
  const receiverType = context.checker.getNonNullableType(context.types.rawTypeAt(receiver))
  for (const member of receiverType.getProperties()) {
    // Only a symbol-named member can match, and the checker spells those with
    // its own `__@` prefix -- the same test `keyOfSymbol` uses to decide a key
    // is a symbol at all.
    if (!member.getName().startsWith('__@')) continue
    const declaration = symbolKeyDeclarationOf(context.checker, context.identities, member)
    if (declaration && context.identities.declarationIdOf(declaration) === key.declaration) {
      return symbolPropertyKeyText(key.declaration)
    }
  }
  return null
}

/** A callable's own declared property key as `SetFunctionName` would spell it: no leading `#` for a private name. */
const declaredCallableKeyTextOf = (name: ts.PropertyName): string | null => {
  if (ts.isIdentifier(name)) return name.text
  if (ts.isPrivateIdentifier(name)) return name.text.replace(/^#/, '')
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  if (ts.isComputedPropertyName(name)) {
    const expression = name.expression
    if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) return expression.text
  }
  return null
}

type NamedCallableNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration

/**
 * The name an anonymous function/arrow expression inherits from the exact
 * syntax position it was defined at, per ECMA-262 `NamedEvaluation`
 * (14.4.13's own runs of it, 8.6.2 `SingleNameBinding`, 13.2.5.5 property
 * definition, 13.15.2 simple assignment) -- or `''` when the position gives
 * it none, which IS the anonymous function's real `[[Name]]`
 * (`(function(){}).name === ''`).
 *
 * Every branch is one grammar production the spec runs `NamedEvaluation`
 * from: a variable/binding-element/parameter's own plain-identifier
 * Initializer (covers `const f = () => {}`, destructuring and default-parameter
 * defaults alike -- `[arrow = () => {}]` is a `BindingElement` exactly as
 * `function f(x = () => {})` is a `ParameterDeclaration`), an
 * object-literal/class-field property's own value, a simple assignment's
 * right-hand side, and a bare default export. `parent` is always populated:
 * every caller reaches this only after the checker has bound the file.
 */
const namedEvaluationNameOf = (node: ts.Expression): string => {
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) return parent.name.text
  if (ts.isBindingElement(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) return parent.name.text
  if (ts.isParameter(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) return parent.name.text
  if (ts.isPropertyDeclaration(parent) && parent.initializer === node) {
    const key = declaredCallableKeyTextOf(parent.name)
    if (key !== null) return key
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
    const key = declaredCallableKeyTextOf(parent.name)
    if (key !== null) return key
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node &&
    ts.isIdentifier(parent.left)
  ) {
    return parent.left.text
  }
  if (ts.isExportAssignment(parent) && !parent.isExportEquals && parent.expression === node) return 'default'
  return ''
}

/**
 * ECMA-262's `[[Name]]` internal slot for a callable, decided entirely at
 * compile time from its syntax: a function/method/accessor's own written
 * name (with `get `/`set ` prefixed for an accessor, exactly as
 * `MethodDefinitionEvaluation`'s own `SetFunctionName` calls do), or --
 * for an anonymous function/arrow expression -- the `NamedEvaluation` name
 * from wherever it was defined (`namedEvaluationNameOf`).
 *
 * Both halves are pure syntax facts, independent of any value the callable
 * ever carries at runtime, which is what makes this safe to decide once per
 * allocation site and register in the runtime's static `SourceRegistration`
 * table exactly as `functionSource` already is -- see
 * `producers/allocations.ts`'s and `producers/class-lifecycle.ts`'s own
 * `functionName` fields.
 */
/**
 * ECMA-262's `[[Name]]` for a class constructor, the same way
 * `staticFunctionNameOf` below decides it for a function: the class's own
 * written name, or -- for an anonymous class expression -- the
 * `NamedEvaluation` name of the position it was written in (`const A = class
 * {}` is `"A"`, `[cls = class {}]` is `"cls"`), or `"default"` for an
 * anonymous `export default class`. A class that declares its own static
 * `name` member shadows this at the read site, which is the reader's rule
 * (`emit-class-properties.ts`'s static-member walk runs first), not this one's.
 */
export const staticClassNameOf = (node: ts.ClassLikeDeclaration): string => {
  if (node.name) return node.name.text
  if (ts.isClassExpression(node)) return namedEvaluationNameOf(node)
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : ''
}

/**
 * `Function.prototype.length` for a class constructor: the written
 * constructor's `ExpectedArgumentCount` (`expectedParameterCountOf`), or 0
 * for a class relying on the implicit one -- the default constructor of a
 * base class takes no parameters, and a derived class's `(...args)` has a
 * rest parameter first, so both count 0.
 */
export const staticClassLengthOf = (node: ts.ClassLikeDeclaration): number => {
  const written = node.members.find(
    (member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && member.body !== undefined
  )
  return written ? expectedParameterCountOf(written) : 0
}

export const staticFunctionNameOf = (node: NamedCallableNode): string => {
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    const key = declaredCallableKeyTextOf(node.name)
    if (key === null) return ''
    return (ts.isGetAccessorDeclaration(node) ? 'get ' : ts.isSetAccessorDeclaration(node) ? 'set ' : '') + key
  }
  if (ts.isFunctionDeclaration(node)) {
    if (node.name) return node.name.text
    // `export default function () {}`: an anonymous HoistableDeclaration whose
    // default export IS its `NamedEvaluation` position (ECMA-262 `ExportDeclaration
    // : export default HoistableDeclaration`), so it names 'default' even though
    // there is no assignment expression for `namedEvaluationNameOf` to walk up to.
    return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : ''
  }
  if (ts.isFunctionExpression(node) && node.name) return node.name.text
  return namedEvaluationNameOf(node)
}

/**
 * ECMA-262 `ExpectedArgumentCount`: the leading run of a callable's own
 * written parameters, up to (and excluding) the first one that has a default
 * initializer or is a rest parameter. This is `Function.prototype.length`,
 * and it is a fact about the written parameter list alone -- independent of
 * `NamedEvaluation`, and independent of the calling convention this compiler
 * projects, which erases exactly the "has a default" bit this needs (a
 * defaulted parameter is narrowed to its own storage type same as a required
 * one). So it is read directly off the syntax here, once, the same way
 * `functionSource` is.
 *
 * TypeScript's synthetic `this` parameter (`function f(this: Foo, x: number)`)
 * binds no argument position and is invisible to `.length`; the grammar
 * allows it only in leading position, so skipping index 0 when it names
 * `this` is exhaustive.
 */
export const expectedParameterCountOf = (node: ts.SignatureDeclarationBase): number => {
  let count = 0
  for (const [index, parameter] of node.parameters.entries()) {
    if (index === 0 && ts.isIdentifier(parameter.name) && parameter.name.text === 'this') continue
    if (parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined) break
    count++
  }
  return count
}

/**
 * Whether the declaration performs ECMA-262 10.2.5 `MakeConstructor`, and so
 * owns a `prototype` object, or `null` where the answer exists but this
 * compiler does not model it.
 *
 * A syntax fact decided once per allocation site, exactly as
 * `expectedParameterCountOf` above is: an ordinary `function` declaration or
 * expression makes a constructor, while an arrow, a method, an accessor and
 * an `async function` are created by `OrdinaryFunctionCreate` with no such
 * step and own no `prototype` at all.
 *
 * A generator answers `null` rather than `true`. It does own a `prototype`,
 * but 27.3.1's object inherits `%GeneratorFunction.prototype.prototype%`,
 * which this runtime has no object for -- and reporting `true` would hand a
 * read a plain object whose `constructor` chain is wrong. `null` keeps the
 * read refused, which is the honest answer while that intrinsic is missing.
 */
export const ownPrototypePropertyOf = (node: ts.Node): boolean | null => {
  if ('asteriskToken' in node && (node as ts.FunctionLikeDeclaration).asteriskToken !== undefined) return null
  if (!ts.isFunctionDeclaration(node) && !ts.isFunctionExpression(node)) return false
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) !== true
}
