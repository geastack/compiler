import ts from 'typescript'
import { intrinsicPropertyCallOf } from '../intrinsic-property-call.js'
import { contributeObjectTag } from './object-tag.js'
import { bagShapeTypeAt } from '../object-bag-bindings.js'
import { isFabricatedSignatureShape, structuralCallSignatures } from '../structural-callable.js'
import { contextualArrayConstructTypeAt, contextualCollectionTypeAt, statedCollectionTypeAt } from '../structural-array-element.js'
import { implementationSignatureOf } from '../structural-declarations.js'
import { physicalGeneratorOverloadResultAt } from '../physical-overload-result.js'
import { regionId, semanticResultId, type StructuralTypeId } from '../../../identity/ids.js'
import type { CensusCandidate } from '../census.js'
import type { CandidateContribution, FamilyProducer } from '../contribution.js'
import type { ProducerContext } from '../producer-context.js'
import { bindingKindOf } from './binding-kind.js'
import { declaresExactArms } from './exact-arms.js'
import { blocked, mintOperationId, mintResult, operand } from './mint.js'
import {
  calleeAwareTypeAt,
  objectDescriptorReturnTypeAt,
  resolvedCalleeSignatureType,
  sourceForValue,
  unwrapErased,
  valueEdgesInto
} from './shared.js'
import type { CitedBranch } from './references.js'
import { isShortCircuitingCall, optionalChainGuardOf, optionalCallGuardOf, presentReturnTypeOf } from './optional-chain.js'
import { buildArgumentOperands } from './spread-arguments.js'
import { contributeTaggedTemplate } from './tagged-template.js'
import {
  normalCompletion,
  pureEffects,
  throwingCompletion,
  type OperandEvaluation,
  type OperandSource,
  type SemanticOperand
} from '../../model/operands.js'
import type { SemanticEdge } from '../../model/edges.js'
import type {
  BindingOperation,
  ClassLifecycleOperation,
  ConversionRoleTarget,
  InvocationOperation,
  ReferenceOperation,
  SemanticRuntimeTarget,
  SemanticTargetProof
} from '../../model/operations.js'
import { genericFunctionSetMembersOf } from '../../model/structural-types.js'
import { rootSpecialization } from '../identities.js'
import {
  isUniqueSymbolFreshType,
  validateInvocationResult,
  type InvocationResultDivergence,
  type SelectedSignature,
  type SignatureProvenance,
  type TypeArgumentProvenance
} from '../../model/selected-signature.js'
import type { SignatureParameter } from '../../model/structural-types.js'
import { impliedPatternArrayElementAt, parameterSlotTypeOf } from '../parameter-slot.js'
import { isGlobalObjectConstructor, isStandardGlobalValue, objectAssignTargetType } from '../derived-expression-type.js'
import { transparentConstClassAliasTarget } from '../../class-alias.js'
import { scriptGlobalValueRedefinitionOf } from '../script-global-redefinition.js'
import { mentionsTypeParameter } from '../return-bindings.js'

type FunctionLikeSourceDeclaration =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration

const isFunctionLikeSourceDeclaration = (declaration: ts.Node): declaration is FunctionLikeSourceDeclaration =>
  ts.isFunctionDeclaration(declaration) ||
  ts.isFunctionExpression(declaration) ||
  ts.isArrowFunction(declaration) ||
  ts.isMethodDeclaration(declaration) ||
  ts.isConstructorDeclaration(declaration) ||
  ts.isGetAccessorDeclaration(declaration) ||
  ts.isSetAccessorDeclaration(declaration)

const typeParametersOf = (declaration: ts.SignatureDeclaration | ts.JSDocSignature): readonly ts.TypeParameterDeclaration[] => {
  // `JSDocSignature.typeParameters` is a different node kind (`JSDocTemplateTag`);
  // a JSDoc-only signature never carries a real, checker-selectable type
  // parameter declaration, so it contributes none here.
  if (ts.isJSDocSignature(declaration)) return []
  return declaration.typeParameters ?? []
}

const parameterShapeOf = (context: ProducerContext, parameter: ts.Symbol, anchor: ts.Node): SignatureParameter => {
  const declaration = context.identities.declarationOfSymbol(parameter)
  const isParameter = declaration !== null && ts.isParameter(declaration)
  // HOLDS: this callee's OWN parameter, read the census-aware way when it has
  // a real parameter node to key on -- `context.types.rawTypeAt`, the same
  // raw-`ts.Type` census answer `siteReturn` below already uses for the
  // return side. An unannotated JS parameter is exactly the largest single
  // boxed-carrier family this compiler has (the parameter census exists to
  // infer it from call sites), and unlike `returnType` there is no second
  // authority downstream to disagree with: `validateInvocationResult` checks
  // only `returnType` against the invocation result, never `parameters`, and
  // both `type` and `slot` below are derived from this one `declared` value,
  // so there is nothing for this to drift out of step with.
  // The SYMBOL's own type, which for a member of an instantiated generic is
  // the substituted one: `WeakMap<Texture, number>.delete`'s parameter symbol
  // says `Texture`, while its declaration node in `lib.es2015.collection.d.ts`
  // says `K` and always will -- one node, every instantiation in the program.
  const fromSymbol = context.checker.getTypeOfSymbolAtLocation(parameter, declaration ?? anchor)
  // A parameter whose DECLARATION is still open where this call's own resolved
  // signature has closed it. `rawTypeAt` reads the declaration node, which is
  // the right authority for the census (below) and the wrong one for an
  // ambient generic's member: three's `_videoTextures.delete( texture )` and
  // `_sources.has( source )` published `unresolved(type parameter K)` as the
  // parameter slot while the callee carrier beside it correctly said
  // `(class-ref(Texture)) -> boolean` -- two authorities over one call, and
  // preflight believes the slot. Gated on the symbol having actually CLOSED
  // it: a genuinely generic callee this compiler monomorphizes reads `T` at
  // both, and its copy is what substitutes, so nothing there changes.
  const substituted = isParameter && mentionsTypeParameter(context.types.rawTypeAt(declaration)) && !mentionsTypeParameter(fromSymbol)
  const declared = isParameter && !substituted ? context.types.rawTypeAt(declaration) : fromSymbol
  const flags = {
    optional: isParameter ? declaration.questionToken !== undefined : false,
    rest: isParameter ? declaration.dotDotDotToken !== undefined : false,
    hasInitializer: isParameter ? declaration.initializer !== undefined : false
  }
  // A destructured parameter the program never annotated is the array its
  // call sites pass, not the tuple the checker implied from the pattern --
  // the same answer `structural-parts.ts`'s `parameterOf` gives the callee's
  // own slot, asked of the one function so the two cannot drift.
  const impliedElement = isParameter ? impliedPatternArrayElementAt(context.checker, context.parameters, declaration) : null
  // The body, callable ABI and invocation frame all consume the same bag
  // storage answer. Reading the raw checker image here reconstructs the old
  // literal shape and copies away fields that the census added later.
  const bag = isParameter && !substituted ? bagShapeTypeAt(context.table, context.types.typeOf, context.bags, declaration) : null
  const type =
    bag ??
    (impliedElement
      ? context.table.intern({ kind: 'array', element: context.types.typeOf(impliedElement), readonly: false, extension: [] })
      : context.types.typeOf(declared))
  const slot = parameterSlotTypeOf(
    (members) => context.table.intern({ kind: 'union', members }),
    context.types.typeOf(context.checker.getUndefinedType()),
    flags,
    type
  )
  return { type, slot, ...flags }
}

// `getMinArgumentCount` is checker-internal; the public answer is the count of
// leading parameters before the first optional, defaulted, or rest parameter.
/**
 * The implementation signature behind a resolved overload of a SOURCE
 * function or method, or `null` when the signature is not one -- an
 * implementation with a body of its own, an ambient overload set, a signature
 * with no declaration.
 *
 * Only a non-generic implementation answers here. A generic one is
 * instantiated per copy, and the copy a call reaches types its parameters
 * and result -- the resolved signature the checker instantiated stays the
 * call's convention while the target names the implementation's copy.
 */
const sourceImplementationSignatureOf = (
  context: ProducerContext,
  signature: ts.Signature | undefined,
  generic: 'generic-too' | 'non-generic-only' = 'non-generic-only'
): ts.Signature | null => {
  const declaration = signature?.declaration
  if (!declaration || !(ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration))) return null
  if (declaration.body !== undefined || declaration.getSourceFile().isDeclarationFile) return null
  const implementation = implementationSignatureOf(context.checker, declaration)
  if (!implementation) return null
  return generic === 'generic-too' || (implementation.getTypeParameters()?.length ?? 0) === 0 ? implementation : null
}

const minimumArityOf = (context: ProducerContext, signature: ts.Signature): number => {
  let required = 0
  for (const parameter of signature.getParameters()) {
    const declaration = context.identities.declarationOfSymbol(parameter)
    if (!declaration || !ts.isParameter(declaration)) break
    if (declaration.questionToken || declaration.initializer || declaration.dotDotDotToken) break
    required += 1
  }
  return required
}

/**
 * The physical parameter slots a non-generic selected signature owns.
 *
 * The callee representation may be unavailable or deliberately open when
 * preflight runs, but that does not erase the checker's authenticated frame.
 * Publishing it here lets the conversion census ask whether an argument can
 * enter the slot that owns it, rather than incorrectly asking whether it can
 * become the call's return value. Inferred generic instantiations are omitted:
 * the public checker API does not expose their mapper, and guessing it from an
 * argument would create a second authority over the slot type.
 */
const argumentConversionRolesOf = (
  selected: SelectedSignature | null,
  operands: readonly SemanticOperand[]
): readonly ConversionRoleTarget[] => {
  if (!selected || selected.typeArguments.kind !== 'none') return []
  const roles: ConversionRoleTarget[] = []
  for (const argument of operands) {
    if (argument.role !== 'argument') continue
    const parameter = selected.parameters[argument.ordinal]
    // A rest argument is range-packed into the rest ARRAY by a different
    // operation. Its element target is not the parameter slot itself, so this
    // operation must not claim one it does not own.
    if (!parameter || parameter.rest) continue
    roles.push({ role: 'argument', ordinal: argument.ordinal, owner: 'parameter-slot', type: parameter.slot })
  }
  return roles
}

/**
 * The `exact-arm` roles of a call into an `@gea-exact-arms` implementation
 * (`ConversionRoleTarget.owner`): each argument's type under the overload the
 * checker resolved. Published beside the implementation's own
 * `parameter-slot` roles rather than instead of them, because the slot is
 * still the implementation's union -- this only says which arm of it the
 * argument enters. Nothing for a call that resolved straight to the body
 * (no overload was chosen, so there is no arm to name) or to a generic
 * overload (the instantiated parameter types are not public, exactly as
 * `argumentConversionRolesOf` refuses them).
 */
const exactArmArgumentRolesOf = (
  context: ProducerContext,
  node: ts.CallExpression | ts.NewExpression,
  resolved: ts.Signature | undefined,
  implementation: ts.Signature | null,
  operands: readonly SemanticOperand[]
): readonly ConversionRoleTarget[] => {
  if (!resolved || !implementation?.declaration || !declaresExactArms(implementation.declaration)) return []
  const selected = buildSelectedSignature(context, node, resolved)
  if (!selected || selected.typeArguments.kind !== 'none') return []
  const roles: ConversionRoleTarget[] = []
  for (const argument of operands) {
    if (argument.role !== 'argument') continue
    const parameter = selected.parameters[argument.ordinal]
    if (!parameter || parameter.rest) continue
    roles.push({ role: 'argument', ordinal: argument.ordinal, owner: 'exact-arm', type: parameter.slot })
  }
  return roles
}

const buildSelectedSignature = (
  context: ProducerContext,
  node: ts.CallExpression | ts.NewExpression,
  signature: ts.Signature
): SelectedSignature | null => {
  const declaration = signature.declaration
  // No declaration node (the implicit constructor of a class with no written
  // one, chiefly) means no `DeclarationId` can be named without fabricating
  // one. `null` is the honest answer, matching an unresolved call.
  if (!declaration) return null
  const declarationId = context.identities.declarationIdOf(declaration)
  const provenance: SignatureProvenance = declaration.getSourceFile().isDeclarationFile ? 'ambient' : 'source'

  // STATED, not held: a `this` parameter is either written out explicitly
  // (`function f(this: Foo)`, read at its own node) or wholly implicit, with
  // no call-site argument ever supplying it for a census to infer from --
  // unlike an ordinary parameter, nothing here is a program binding the
  // parameter census's call-site evidence could improve on.
  const thisParameterSymbol = signature.thisParameter
  const thisParameter = thisParameterSymbol
    ? context.types.typeOf(
        context.checker.getTypeOfSymbolAtLocation(thisParameterSymbol, thisParameterSymbol.valueDeclaration ?? declaration)
      )
    : null

  const parameters = signature.getParameters().map((parameter) => parameterShapeOf(context, parameter, declaration))

  const writtenTypeArguments = node.typeArguments
  const typeParameters = typeParametersOf(declaration)
  const typeArguments: TypeArgumentProvenance =
    writtenTypeArguments && writtenTypeArguments.length > 0
      ? {
          kind: 'explicit',
          arguments: writtenTypeArguments.flatMap((argumentNode, index) => {
            const parameterDeclaration = typeParameters[index]
            if (!parameterDeclaration) return []
            return [
              {
                parameter: context.identities.declarationIdOf(parameterDeclaration),
                argument: context.types.typeOf(context.checker.getTypeFromTypeNode(argumentNode))
              }
            ]
          })
        }
      : (signature.typeParameters?.length ?? 0) > 0
        ? { kind: 'inferred', reason: 'checker-mapper-not-public' }
        : { kind: 'none' }

  // An async signature's checker return type really is `Promise<T>` -- this
  // used to unwrap it to `T` here, in lockstep with the same reverted unwrap
  // in `structural.ts`'s `signatureOf` and this file's own call-expression
  // `resultType` below. `promise` is now a real, statically-typed carrier
  // (`representation/derive.ts`'s `PromiseDeclarationPolicy`), so
  // `SelectedSignature.returnType` stays the checker's own declared type and
  // `validateInvocationResult` compares it against a `resultType` that
  // agrees for the same reason (both now un-awaited). See citations.md
  // finding 2.
  const returnType = isShortCircuitingCall(node) ? presentReturnTypeOf(context.checker, signature) : signature.getReturnType()
  // ONE authority on what this callee returns.
  //
  // The invocation RESULT below is `context.types.typeAt(node)`, which reaches
  // the return census through the composed `ParameterBindingCensus` that
  // `structural.ts` threads. This line asked the bare checker, so for every
  // unannotated JS function the census resolved, the two halves of one
  // operation answered differently and `validateInvocationResult` failed the
  // producer closed -- correctly, because a producer really had published two
  // answers for one operation. The consequence is not a reported blocker but a
  // WITHHELD operation, which silently takes its citers with it: three's
  // `createCanvasElement` carries `@return {HTMLCanvasElement}`, a class the
  // host declares absent, while its body returns what `createElementNS`
  // actually yields on this target -- and because that call is the default
  // initializer of `canvas` in `const { canvas = createCanvasElement(), context
  // = null, ... } = parameters`, the whole `WebGLRenderer` configuration
  // pattern went with it, `context` included. Measured on the three.js app: 26 of these
  // disagreements across 14 declarations, withholding 52 of its 86 withheld
  // producers and 105 operations.
  //
  // The cure is to read the census, never to widen the guard.
  // `producer-context.ts` predicted this exact failure when it declared
  // `returns` and left it unconsumed -- "never both, or a call site the
  // composed census resolves and a producer resolves independently could
  // disagree about its own result's carrier". `frontend.ts` now populates it
  // with the SAME instance the composed view answers from, so the two are one
  // authority rather than two that agree by luck.
  //
  // The census answers for the DECLARATION, so its answer is already the
  // PRESENT return: an optional chain's `undefined` is a fact about a call
  // expression, not about the callee, which is the whole reason
  // `presentReturnTypeOf` exists. Consulting the census first therefore needs
  // no separate stripping, and the checker's answer stays the fallback for
  // every declaration the census refused.
  // An overload set whose one body is a GENERATOR: the overload signature
  // `signature.getReturnType()` just read is a bodiless declaration, so the
  // return census below has no body to read for it and would leave the
  // checker's `IterableIterator<T>` standing against a call result
  // `structural.ts`'s `typeAt` already publishes as the implementation's own
  // `Generator<T>`. Both sides read `physicalGeneratorOverloadResultAt`, so
  // this is one authority rather than a divergence to declare -- see that
  // function's header for why a generator is the one overload shape where the
  // body and its signatures cannot be reconciled by widening.
  const physicalGeneratorReturn = physicalGeneratorOverloadResultAt(context.checker, node)
  if (physicalGeneratorReturn !== null) {
    return {
      declaration: declarationId,
      provenance,
      parameters,
      minimumArity: minimumArityOf(context, signature),
      thisParameter,
      typeArguments,
      returnType: context.types.typeOf(physicalGeneratorReturn)
    }
  }
  // `Object.getOwnPropertyDescriptor(receiver, key)` off a receiver this
  // compiler already gave a real, in-program shape (a record literal, an
  // array, an in-program function): the ambient declaration below has no
  // body for `context.returns` to read (it is a lib.d.ts method signature),
  // so nothing past this point would ever narrow its `value?: any` away from
  // `dynamic` -- see `objectDescriptorReturnTypeAt`'s own header for why this
  // is the one call the census-return path below can never reach on its own.
  const descriptorReturn = objectDescriptorReturnTypeAt(context, node)
  if (descriptorReturn !== null) {
    return {
      declaration: declarationId,
      provenance,
      parameters,
      minimumArity: minimumArityOf(context, signature),
      thisParameter,
      typeArguments,
      returnType: descriptorReturn
    }
  }
  // `host.readFile.bind(host)`: the mapper states the bound callable's
  // convention, receiver-less; the checker's own return type is the method's.
  const nativeResult = context.types.boundCallResultAt(node) ?? context.types.constructResultAt(node)
  if (nativeResult !== null) {
    return {
      declaration: declarationId,
      provenance,
      parameters,
      minimumArity: minimumArityOf(context, signature),
      thisParameter,
      typeArguments,
      returnType: nativeResult
    }
  }
  const censusReturn = context.returns?.typeAt(declaration) ?? null
  const censusReturnArms = context.returns?.unionArmsAt(declaration) ?? null
  // ...and the SAME absent substitution, for the same reason.
  //
  // Sharing the census closed 22 of the three.js app's 26 disagreements. The four left
  // were a second asymmetry between the two sides: `typeAt` ends in
  // `typeOf(absentSubstitutedTypeAt(node))`, so the RESULT has every
  // host-absent class collapsed to `never` before it is interned, while
  // `typeOf` alone does not, so this side kept the class. Three's
  // `createCanvasElement` returns `@return {HTMLCanvasElement}`, `WebGLTextures`
  // constructs `new OffscreenCanvas(...)`, and the webgl plugin lists both
  // absent -- so the two sides interned two different ids for one type that
  // cannot exist, and the guard fired on a disagreement about nothing.
  //
  // Only the type-level substitution, never `absentSubstitutedTypeAt`: that
  // helper also walks a property access's RECEIVER, which is a question about
  // where a value came from and has no meaning for a return type.
  // `context.returns` answers about the DECLARATION alone -- what a function
  // BODY's own `return`s agree on -- so it has nothing to say for a
  // signature whose declaration is an abstract call-signature member (an
  // interface/type-alias entry, no body to read): hono's `H`, never
  // instantiating its trailing generic, resolves ONE real two-parameter
  // signature whose return the checker still collapses to plain `any`.
  // `censusReturn` above is null there, so `returnType` stays the checker's
  // raw `any` with nothing left to try -- and the INVOCATION side
  // (`resultType`, below, `context.types.typeAt(node)`) may by then have a
  // real answer from the same call site's own data flow (a `res = <this
  // call>` write a local-binding census resolved backward from its
  // enclosing function's stated return), which `validateInvocationResult`
  // then refuses as a disagreement between two authorities that were never
  // actually asked the same question. One last fallback closes it: the same
  // call-site census, asked directly at this node, so both sides of the
  // comparison below can only ever agree.
  const siteReturn =
    censusReturn === null && (returnType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ? context.types.rawTypeAt(node) : null
  const siteReturnIsUsable =
    siteReturn !== null && (siteReturn.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Void | ts.TypeFlags.Never)) === 0
  const substituted = context.absentGlobals.substituteAbsentType(censusReturn ?? (siteReturnIsUsable ? siteReturn : returnType))
  return {
    declaration: declarationId,
    provenance,
    parameters,
    minimumArity: minimumArityOf(context, signature),
    thisParameter,
    typeArguments,
    // A synthesized union has no public ts.Type. Its declaration and call
    // result still share the return census's exact alternatives.
    returnType: censusReturnArms
      ? context.table.intern({
          kind: 'union',
          members: censusReturnArms.map((arm) => context.types.typeOf(context.absentGlobals.substituteAbsentType(arm)))
        })
      : context.types.typeOf(substituted)
  }
}

const isNeverReassignedBinding = (
  context: ProducerContext,
  declaration: ts.Declaration,
  symbol: ts.Symbol,
  qualified: boolean
): boolean => {
  if (ts.isVariableDeclaration(declaration)) {
    const list = declaration.parent
    // Reassigning a `const` is a compile error, so a program that reaches
    // normalization already cannot have done it -- the grammar guarantees
    // this, not a reference scan.
    return ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0
  }
  if (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
    // A namespace export can be written from ANY file (`ts.Debug.x = ...`),
    // so a qualified name asks the program-wide question; a module-local
    // binding can only be written in its own file (the census's own comment
    // states why), so the bare name keeps the one-file bound.
    return qualified
      ? !context.reassignedBindings.isReassignedAnywhere(symbol)
      : !context.reassignedBindings.isReassignedIn(declaration.getSourceFile(), symbol)
  }
  return false
}

/**
 * Whether a never-reassigned binding is known to hold `declaration` and
 * nothing else.
 *
 * The checker's resolved signature names ONE declaration, but a `const`
 * whose initializer chooses at runtime (`cond ? identity : setOriginalNode`)
 * holds whichever arm the condition picked -- naming the resolved arm as an
 * exact target would run the wrong body when the other arm was chosen. So
 * a variable binding is exact only when its initializer is one hop from the
 * target: the declaration itself (a function expression / arrow), or a name
 * whose symbol is declared by it (any overload of it counts -- the
 * implementation is what runs). A function or class declaration IS the
 * target and needs no initializer.
 */
const bindingHoldsExactly = (
  context: ProducerContext,
  binding: ts.Declaration,
  declaration: ts.Declaration,
  seen: Set<ts.Declaration> = new Set()
): boolean => {
  if (!ts.isVariableDeclaration(binding)) return true
  if (seen.has(binding)) return false
  seen.add(binding)
  const initializer = binding.initializer ? unwrapErased(binding.initializer) : undefined
  if (!initializer) return false
  if ((initializer as ts.Node) === declaration) return true
  const symbol = ts.isIdentifier(initializer)
    ? context.checker.getSymbolAtLocation(initializer)
    : ts.isPropertyAccessExpression(initializer)
      ? (context.namespacePaths.memberSymbolOf(initializer) ?? context.checker.getSymbolAtLocation(initializer.name))
      : undefined
  if (!symbol) return false
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? context.checker.getAliasedSymbol(symbol) : symbol
  const declarations = resolved.getDeclarations() ?? []
  if (declarations.includes(declaration)) return true
  // `const g = f` where `f` is itself a never-reassigned binding: the same
  // question one hop further, with the same grammar guarantee.
  const next = context.identities.declarationOfSymbol(resolved)
  return (
    next !== null &&
    ts.isVariableDeclaration(next) &&
    isNeverReassignedBinding(context, next, resolved, false) &&
    bindingHoldsExactly(context, next, declaration, seen)
  )
}

const exactFunctionTarget = (
  context: ProducerContext,
  node: ts.CallExpression | ts.NewExpression,
  signature: ts.Signature
): SemanticTargetProof | null => {
  // A resolved overload of a source function names a body-less declaration;
  // the body it runs is the implementation's, exactly as `identities.ts`'s
  // `valueDeclarationOfSymbol` names it for every read of the same symbol.
  const declaration = sourceImplementationSignatureOf(context, signature, 'generic-too')?.declaration ?? signature.declaration
  if (!declaration || !isFunctionLikeSourceDeclaration(declaration)) return null
  if (declaration.getSourceFile().isDeclarationFile) return null
  if (!declaration.body) return null
  const callee = unwrapErased(node.expression)
  // A namespace-qualified callee (`Debug.assert(...)`) names its declaration
  // exactly as a bare identifier does -- see `namespace-paths.ts`.
  const symbol = ts.isIdentifier(callee)
    ? context.checker.getSymbolAtLocation(callee)
    : ts.isPropertyAccessExpression(callee)
      ? (context.namespacePaths.memberSymbolOf(callee) ?? undefined)
      : undefined
  if (!symbol) return null
  const bindingDeclaration = context.identities.declarationOfSymbol(symbol)
  if (!bindingDeclaration || !isNeverReassignedBinding(context, bindingDeclaration, symbol, !ts.isIdentifier(callee))) return null
  if (!bindingHoldsExactly(context, bindingDeclaration, declaration)) return null
  const constructable =
    ts.isConstructorDeclaration(declaration) ||
    ((ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration)) &&
      declaration.asteriskToken === undefined &&
      (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Async) === 0)
  return {
    kind: 'exact',
    target: { kind: 'function', functionId: context.identities.functionIdOf(declaration), constructable },
    evidence: [
      ts.isIdentifier(callee) ? 'direct-identifier-callee' : 'namespace-qualified-callee',
      'never-reassigned-binding',
      'function-like-declaration-in-source'
    ]
  }
}

const implicitSourceConstructorTarget = (context: ProducerContext, node: ts.NewExpression): SemanticTargetProof | null => {
  // HOLDS: what `new`'s own callee expression refers to, read the
  // census-aware way (`context.types.rawTypeAt`) rather than the bare
  // checker -- `new ctor()` where `ctor` is an unannotated parameter/local
  // the census resolved to a real class is exactly the shape this should not
  // miss. Falls back to the checker's own answer unchanged when the census
  // has nothing to add, so an ordinary `new ClassName()` is unaffected.
  const calleeType = context.types.rawTypeAt(node.expression)
  const symbol = calleeType.getSymbol()
  if (!symbol) return null
  const declaration = context.identities.declarationOfSymbol(symbol)
  if (!declaration || !ts.isClassLike(declaration)) return null
  if (declaration.members.some(ts.isConstructorDeclaration)) return null
  return {
    kind: 'exact',
    target: { kind: 'implicit-source-constructor', classDeclaration: context.identities.declarationIdOf(declaration) },
    evidence: ['new-on-class-without-own-constructor']
  }
}

/**
 * A call through a CHOICE of generic source functions: the closed family of
 * the copies this call instantiates, one per member, in the member order the
 * set's carrier tags (`genericFunctionSetMembersOf`).
 *
 * The callee's value is the set's tag, not a callable (`generic-function-set`,
 * representation/model.ts), so there is no frame to call through; the family
 * is what `ir/lower-invocation.ts` dispatches over. Each target names the
 * member it runs for, since the copies' ids do not spell the root declaration.
 */
const genericSetFamilyTarget = (context: ProducerContext, node: ts.CallExpression): SemanticTargetProof | null => {
  const callee = unwrapErased(node.expression)
  const shape = context.table.get(context.types.typeAt(callee)).shape
  const members = genericFunctionSetMembersOf((id) => context.table.get(id).shape, shape)
  if (!members) return null
  const copies = context.specializations.setSpecializationsAt(node, context.types.substituteTypeParameter)
  if (!copies) return null
  const targets: SemanticRuntimeTarget[] = []
  for (const copy of copies) {
    const member = context.identities.declarationIdOf(copy.declaration, rootSpecialization)
    if (!members.includes(member)) return null
    const enclosing = context.identities.prefixFor(copy.declaration, context.path)
    const last = enclosing[enclosing.length - 1]
    const isSelfReference = last !== undefined && last.owner === copy.declaration && last.ordinal === copy.ordinal
    const copyPath = isSelfReference ? enclosing : [...enclosing, { owner: copy.declaration, ordinal: copy.ordinal }]
    targets.push({
      kind: 'function',
      functionId: context.identities.functionIdOf(copy.declaration, copyPath),
      constructable: false,
      member
    })
  }
  if (targets.length !== members.length) return null
  return { kind: 'closed-family', targets, evidence: ['generic-function-set-callee', 'one-instantiated-copy-per-member'] }
}

const buildTarget = (
  context: ProducerContext,
  node: ts.CallExpression | ts.NewExpression,
  signature: ts.Signature | undefined
): SemanticTargetProof => {
  if (ts.isNewExpression(node)) {
    const implicit = implicitSourceConstructorTarget(context, node)
    if (implicit) return implicit
  } else {
    const family = genericSetFamilyTarget(context, node)
    if (family) return family
  }
  if (signature) {
    const exact = exactFunctionTarget(context, node, signature)
    if (exact) return exact
  }
  return { kind: 'open', evidence: ['no-static-target-proof'] }
}

/**
 * The constructor body a `super(...)` call sits inside, walked structurally.
 *
 * `super()` is only grammatically legal inside a derived class's constructor
 * (an arrow function nested inside one captures the lexical `super` of the
 * constructor that contains it, so walking through arrows to the nearest
 * enclosing `ConstructorDeclaration` is correct rather than a shortcut). A
 * class's own members always have the class itself as `.parent`, exactly as
 * `class-lifecycle.ts`'s `memberContext` already assumes for every other
 * member kind.
 */
const enclosingConstructorOf = (node: ts.Node): ts.ConstructorDeclaration | null => {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isConstructorDeclaration(current)) return current
  }
  return null
}

/** The reference+binding-read pair minted for `super(...)`'s callee, and the operand source that cites the read. */
interface SuperConstructorRead {
  readonly source: OperandSource
  readonly operations: readonly (ReferenceOperation | BindingOperation)[]
  readonly edges: readonly SemanticEdge[]
}

/**
 * What `super(...)` calls: a fresh read of the enclosing class's own
 * `extends` name, scoped to the constructor `super()` actually runs in.
 *
 * `GetSuperConstructor` (the language's own definition) reads the active
 * function's `[[HomeObject]]`'s prototype -- but for a *constructor*
 * specifically that prototype is always the class's own extended base, fixed
 * once at `ClassDefinitionEvaluation` and never re-evaluated. This compiler
 * already names that base statically as `heritageExpression`
 * (`class-lifecycle.ts`'s `contributeClass`), so no runtime `[[HomeObject]]`
 * lookup is needed -- but citing `contributeClass`'s own `evaluate-heritage`
 * citation directly would be wrong two ways at once. First, it is minted
 * under the *class declaration's* caller, while `super()` executes under the
 * *constructor's* -- a different IR body, and this compiler has no primitive
 * for one body's IR value crossing into another's ("a value produced by a
 * different owner needs capture lowering, which is not supported yet").
 * Second, a heritage expression can carry side effects (`extends getBase()`),
 * and the language evaluates it exactly once at class-definition time; citing
 * the class's own already-computed result would ask for that value, while
 * re-evaluating the expression a second time from inside the constructor
 * would run those side effects again and could even name a different base.
 *
 * A binding read has neither problem: it is keyed by declaration identity, not
 * by which body minted the read (`lowerBinding`'s `read` case loads straight
 * from the named cell), and reading a name is never itself a side effect. So
 * this mints its own `reference`+`binding` pair -- scoped to this call's own
 * candidate and caller, exactly as `references.ts`'s own identifier handling
 * would if `Base` were written again at the `super` keyword's position --
 * restricted to a bare name, which is the one shape a fresh read is honestly
 * equivalent to the original evaluation for. A computed or call-expression
 * heritage stays refused: this compiler has no home-object primitive to
 * answer it another way.
 */
const superConstructorRead = (
  context: ProducerContext,
  candidate: CensusCandidate,
  node: ts.CallExpression
): SuperConstructorRead | null => {
  const enclosingConstructor = enclosingConstructorOf(node)
  const classNode = enclosingConstructor?.parent
  if (!enclosingConstructor || !classNode || !ts.isClassLike(classNode)) return null
  const heritageExpression = classNode.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
    ?.expression
  if (!heritageExpression || !ts.isIdentifier(heritageExpression)) return null

  const heritageValue = transparentConstClassAliasTarget(context.checker, heritageExpression) ?? heritageExpression

  const symbol = context.checker.getSymbolAtLocation(heritageValue)
  if (!symbol) return null
  const declaration = context.identities.symbolDeclarationId(symbol, heritageValue)
  if (!declaration) return null
  const declarationNode = context.identities.declarationOfSymbol(symbol)
  const { mutable, temporalDeadZone } = declarationNode ? bindingKindOf(declarationNode) : { mutable: true, temporalDeadZone: false }
  const type = context.types.typeAt(heritageValue)

  const referenceId = mintOperationId(context.ordinals, candidate.id, 'reference')
  const reference: ReferenceOperation = {
    id: referenceId,
    family: 'reference',
    form: 'identifier',
    strict: ts.isExternalModule(heritageValue.getSourceFile()),
    unresolvableThrows: false,
    hasNoCell: false,
    caller: candidate.caller,
    operands: [],
    results: [mintResult(referenceId, 'reference', type)],
    completion: normalCompletion,
    effects: { ...pureEffects, readsMutableState: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }

  const readId = mintOperationId(context.ordinals, candidate.id, 'binding')
  const read: BindingOperation = {
    id: readId,
    family: 'binding',
    action: 'read',
    declaration,
    mutable,
    temporalDeadZone,
    caller: candidate.caller,
    operands: [
      operand('reference', 0, { kind: 'result', result: semanticResultId(referenceId, 'reference') }, type, { kind: 'provenance' })
    ],
    results: [mintResult(readId, 'value', type)],
    completion: temporalDeadZone ? throwingCompletion : normalCompletion,
    effects: { ...pureEffects, readsMutableState: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }

  return {
    source: { kind: 'result', result: semanticResultId(readId, 'value') },
    operations: [reference, read],
    edges: [{ kind: 'value', result: semanticResultId(referenceId, 'reference'), to: readId, role: 'reference', ordinal: 0 }]
  }
}

/**
 * The `as T`/`<T>x` assertion `node` is the direct operand of, seeing past
 * parentheses the same way `erasure.ts`'s `enclosingCallIfCallee` sees past
 * every erasable wrapper -- but stopping at exactly `as`/`<T>`, unlike that
 * function's fuller list: `satisfies` and `!` are checked WITHOUT changing
 * the expression's own type, so `JSON.parse(text) satisfies Item` and
 * `JSON.parse(text)!` are not a caller stating a DIFFERENT type for this
 * call's own result the way `as Item`/`<Item>JSON.parse(text)` are.
 */
const enclosingTypeAssertion = (node: ts.Node): ts.AsExpression | ts.TypeAssertion | null => {
  let current: ts.Node = node
  let parent: ts.Node | undefined = current.parent
  while (parent !== undefined && ts.isParenthesizedExpression(parent) && parent.expression === current) {
    current = parent
    parent = current.parent
  }
  if (parent === undefined) return null
  if ((ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) && parent.expression === current) return parent
  return null
}

/**
 * `JSON.parse(text) as T`'s call-site override.
 *
 * `JSON.parse`'s own declared signature returns `any` (`lib.es5.d.ts`), so
 * `context.types.typeAt(node)` -- the call expression's OWN published type,
 * independent of any enclosing assertion -- always selects
 * `dynamic(declared-any-never-narrowed)` for it, while a SIBLING producer
 * elsewhere (the binding this call's result flows into) correctly derives
 * the asserted type `T` for that separate SemanticResult. The two never
 * conflict at any existing guard -- nothing publishes "this call's own
 * result disagrees with what its caller asserts" -- so without this override
 * the mismatch is invisible until emission, where it renders a
 * `gea::Value`-typed call assigned into a concrete `T`-typed local: real,
 * uncompilable C++ (see citations.md finding 1's certify-then-fail probe).
 *
 * Narrowly scoped to exactly `JSON.parse(...) as T` / `<T>JSON.parse(...)`,
 * never a general "any `any`-returning call wrapped in `as T` inherits T"
 * rule: for an ordinary user-defined function this compiler also renders the
 * BODY of, the callee's physical ABI returns whatever THAT function's own
 * return type carrier is, regardless of what a caller's assertion claims --
 * overriding the call's own result there would create a genuine ABI
 * mismatch between the call and the function it calls. `JSON.parse` is safe
 * to special-case because this compiler ALSO renders its own implementation
 * (`targets/cpp/emit-json.ts`), which is what makes it physically capable of
 * returning a `T`-shaped value in the first place, not a `gea::Value` this
 * would be reading a lie into.
 *
 * The receiver check asks the checker for the SAME two facts
 * `semantics/frontend.ts`'s fully-generic `ambientHostBindings` already used
 * to bind this exact declaration to protocol `'JSON'` in the first place
 * (the declaration's own spelled name, and that its value declaration lives
 * in a `.d.ts` file rather than this program's own source) -- not a second,
 * independently-drifting spelling check, but a read of the same identity
 * that binding already established, through the only lens `ProducerContext`
 * exposes (it carries no `hostProtocols` map of its own; threading one in was
 * evaluated and rejected as unnecessary plumbing for a single call site).
 * `receiverDeclaration.getSourceFile().isDeclarationFile` is what actually
 * distinguishes the real ambient global from a local `const JSON = {...}`
 * shadow, which would resolve its symbol's value declaration into the
 * program's OWN source file instead.
 */
const jsonParseResultOverride = (context: ProducerContext, node: ts.Node, calleeUnwrapped: ts.Node): StructuralTypeId | null => {
  if (!ts.isPropertyAccessExpression(calleeUnwrapped) || calleeUnwrapped.name.text !== 'parse') return null
  const assertion = enclosingTypeAssertion(node)
  if (!assertion) return null
  const receiverSymbol = context.checker.getSymbolAtLocation(calleeUnwrapped.expression)
  const receiverDeclaration = receiverSymbol?.valueDeclaration
  if (!receiverSymbol || receiverSymbol.name !== 'JSON' || !receiverDeclaration || !receiverDeclaration.getSourceFile().isDeclarationFile) {
    return null
  }
  return context.types.typeAt(assertion)
}

/**
 * `new Array(n)`'s call-site override -- the identical defect
 * `jsonParseResultOverride` exists for, at a different ambient signature.
 *
 * `lib.es5.d.ts`'s `ArrayConstructor` declares `new (arrayLength: number):
 * any[]` -- not generic, so there is no type parameter for a contextual type
 * to narrow the way there would be for, say, `Array.from<T>(...)`. Every
 * `new Array(n)` therefore checks as `any[]` regardless of what it is
 * assigned to, and `context.types.typeAt(node)` -- this call's own published
 * result, same as `JSON.parse`'s -- picks the dynamic carrier for it. The
 * program almost always states its real intent right there: `const xs:
 * Rgb565[] = new Array(n)` declares the element type it wants in the same
 * statement. Left unread, that mismatch is invisible until emission renders
 * a `gea::Value`-element array assigned into a concrete `T`-element one --
 * real, uncompilable C++, `emitArrayConstruct`'s own zero-/length-argument
 * form included (`targets/cpp/emit-callable.ts`).
 *
 * Three sources for the asserted type. The first two are read the same way
 * `jsonParseResultOverride` reads `as T`: an explicit assertion
 * (`new Array(n) as T[]`), and -- the shape this compiler's own corpus
 * actually writes -- the type annotation of the variable or field declaration
 * this construction is the direct initializer of.
 *
 * The third is the call's CONTEXTUAL type, restricted to a destination that
 * is itself an array. The earlier reading of this override said an assignment
 * (`xs = new Array(n)`) must not be consulted because, unlike a fresh
 * declaration's annotation, an assignment target "already has an independent
 * value flowing into it". That is true of a general expression and false of
 * this one: `new Array(n)` is ECMA-262 10.4.2.1, a fresh array of n HOLES,
 * which has no elements of its own for a destination's element type to
 * contradict. There is no independent value here to override -- only an
 * allocation whose element carrier nobody has stated, and a destination that
 * states it. hono's trie router writes exactly that shape
 * (`let partOffsets: number[] | null = null` filled lazily with `partOffsets =
 * new Array(len)`), and the store was refused outright: two `array-object`
 * carriers whose elements disagree have no conversion and may never have one
 * (`targets/cpp/conversions.ts` says why -- a rebuilt array drops every later
 * write through the other name).
 *
 * A union destination is admitted only through its SOLE array arm, which is
 * what `T[] | null` is: the arm is the carrier this construction physically
 * becomes, and the store into the optional is then an ordinary installed
 * widening. Two array arms state nothing this could pick between, and a
 * non-array destination states nothing at all, so both keep `any[]`.
 *
 * Safe for the identical reason `JSON.parse` is: `emitArrayConstruct` is this
 * compiler's own rendering of `new Array(n)`, so it is physically capable of
 * allocating a `T`-element array directly -- this is not reading a lie into a
 * call whose real ABI disagrees.
 */
const arrayConstructResultOverride = (
  context: ProducerContext,
  node: ts.NewExpression,
  calleeUnwrapped: ts.Node
): StructuralTypeId | null => {
  if (!ts.isIdentifier(calleeUnwrapped) || calleeUnwrapped.text !== 'Array') return null
  const receiverSymbol = context.checker.getSymbolAtLocation(calleeUnwrapped)
  const receiverDeclaration = receiverSymbol?.valueDeclaration
  if (
    !receiverSymbol ||
    receiverSymbol.name !== 'Array' ||
    !receiverDeclaration ||
    !receiverDeclaration.getSourceFile().isDeclarationFile
  ) {
    return null
  }
  const assertion = enclosingTypeAssertion(node)
  if (assertion) return context.types.typeAt(assertion)
  let current: ts.Node = node
  let parent: ts.Node | undefined = current.parent
  while (parent !== undefined && ts.isParenthesizedExpression(parent) && parent.expression === current) {
    current = parent
    parent = current.parent
  }
  if (parent === undefined) return null
  if ((ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.initializer === current && parent.type) {
    return context.types.typeAt(parent.type)
  }
  // The contextual path is the type system's, not this override's: the node's
  // own structural rule (`contextual-array-construct`) already answers it, and
  // a second reading here would be a second authority over one allocation --
  // the same division `statedCollectionTypeAt` already keeps below.
  if (contextualArrayConstructTypeAt(context.checker, node)) return context.types.typeAt(node)
  return null
}

/**
 * `Object.create(null)`'s call-site override -- the same shape
 * `arrayConstructResultOverride` above answers, at a third ambient signature
 * whose declared return type is `any`.
 *
 * `lib.es5.d.ts` declares `create(o: object | null): any`, so this call's own
 * published result is `dynamic(declared-any-never-narrowed)` no matter what
 * the program says it is making. `const emptyParams: Params =
 * Object.create(null)` (hono's pattern router) therefore emitted a
 * `gea::Value::object()` -- a runtime `DynamicObject` -- stored into a
 * `gea::Ref<gea::Dictionary<std::string>>` cell through `unboxValue`, whose
 * payload-type check finds two different C++ types and aborts. Not a compile
 * error, not a wrong answer: a program that dies on its first statement.
 *
 * Safe for exactly the reason the other overrides are, and no weaker one:
 * this compiler renders `Object.create`'s own implementation
 * (`targets/cpp/host/emit-host-object.ts`'s `createText`), so it is
 * physically capable of minting the declared carrier directly -- 20.1.2.2's
 * OrdinaryObjectCreate with a null prototype and no own properties IS an
 * empty `gea::Dictionary<V>` or a value-initialized record struct. A carrier
 * `createText` cannot mint keeps the dynamic rendering it always had, so a
 * nonsense annotation fails the same way it did before rather than reading a
 * lie into the call.
 *
 * Only the null-prototype, one-argument form: every other form refuses at
 * emission (a real prototype chain and a properties object are both features
 * this backend has not installed), and a call that will refuse has no result
 * carrier worth overriding.
 */
export const objectCreateResultOverride = (
  context: ProducerContext,
  node: ts.CallExpression,
  calleeUnwrapped: ts.Node
): StructuralTypeId | null => {
  if (!ts.isPropertyAccessExpression(calleeUnwrapped) || calleeUnwrapped.name.text !== 'create') return null
  const receiverSymbol = context.checker.getSymbolAtLocation(calleeUnwrapped.expression)
  const receiverDeclaration = receiverSymbol?.valueDeclaration
  if (
    !receiverSymbol ||
    receiverSymbol.name !== 'Object' ||
    !receiverDeclaration ||
    !receiverDeclaration.getSourceFile().isDeclarationFile
  ) {
    return null
  }
  if (node.arguments.length !== 1 || node.arguments[0]?.kind !== ts.SyntaxKind.NullKeyword) return null
  const assertion = enclosingTypeAssertion(node)
  if (assertion) return context.types.typeAt(assertion)
  // Contextual typing reaches destinations an immediate parent check cannot:
  // an object-literal field, an argument slot, and an indexed assignment are
  // all real declarations of the carrier this fresh null-prototype object
  // must have. The checker exposes that destination directly on the call.
  // Accept only a concrete object shape; `any`, unions, classes and callable
  // contexts keep the dynamic result and therefore cannot silently mint a
  // carrier `Object.create`'s native renderer does not know how to build.
  const contextual = context.checker.getContextualType(node)
  if (contextual !== undefined && (contextual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) {
    const contextualType = context.types.typeOf(contextual)
    let contextualShape = context.table.get(contextualType).shape
    while ((contextualShape.kind === 'declared' || contextualShape.kind === 'object-anchor') && contextualShape.body !== null) {
      contextualShape = context.table.get(contextualShape.body).shape
    }
    if (contextualShape.kind === 'object') return contextualType
  }
  let current: ts.Node = node
  let parent: ts.Node | undefined = current.parent
  while (parent !== undefined && ts.isParenthesizedExpression(parent) && parent.expression === current) {
    current = parent
    parent = current.parent
  }
  if (parent === undefined) return null
  if ((ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.initializer === current && parent.type) {
    return context.types.typeAt(parent.type)
  }
  return null
}

/**
 * `Object.assign(target, source)`'s call result is the target's identity.
 *
 * TypeScript exposes the result as `T & U` so later source code can name the
 * copied keys. ECMAScript performs no conversion or allocation: it writes the
 * source's own properties into `target` and returns `target`. Publishing the
 * intersection as a separate physical record asks the backend to rebuild the
 * object at the call and again when it flows back into a `T` slot, breaking
 * identity and (for an index signature) losing the runtime key set. Publish
 * the target operand's own type instead; `Object.assign`'s native renderer
 * preserves the additional keys in the target's dynamic-property sidecar.
 *
 * Restricted to the authenticated ambient `Object.assign` form with at least
 * one source, and to an object target. A primitive target needs
 * ECMAScript's wrapper-object behavior, which this backend does not model and
 * therefore keeps on the ordinary refused path.
 */
const objectAssignTargetOverride = (
  context: ProducerContext,
  node: ts.CallExpression,
  _calleeUnwrapped: ts.Node
): StructuralTypeId | null => {
  const targetType = objectAssignTargetType(context.checker, node)
  return targetType === null ? null : context.types.typeOf(targetType)
}

/**
 * The seven ambient error constructors, by the name a program spells them.
 *
 * `AggregateError` is deliberately absent, for the reason `gea_runtime.h`
 * gives: its constructor takes the errors first and the message second, so
 * the `create<ErrorRecord>(message)` template every one of these renders
 * through does not describe it.
 */
const errorConstructorNames: ReadonlySet<string> = new Set([
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError'
])

/**
 * `new RangeError(m) as RangeError & { code: string }`'s call-site override --
 * the third instance of the shape `jsonParseResultOverride` and
 * `arrayConstructResultOverride` above already answer, at a third ambient
 * signature.
 *
 * `ErrorConstructor`'s declared return type is the plain `RangeError`
 * interface, so this call's own published result derives the record carrying
 * `name`/`message`/`stack`/`cause` -- while the binding it initializes derives
 * the intersection's record, which declares `code` as well. Two structs, and
 * a value of one is not a value of the other in C++: the store between them
 * has no conversion, certifies clean, and is rejected by clang. `node:http`'s
 * own `validateMaxListeners` is the case.
 *
 * Safe for the identical reason the other two are, and for no weaker one:
 * this compiler renders the construction itself, and its rendering is
 * `gea::host::<Ctor>::create<ErrorRecord>` -- a TEMPLATE over the struct,
 * which value-initializes the record and fills `name` and `message`. So it is
 * physically capable of minting the asserted shape, and the fields the
 * assertion added are left exactly as an omitted property would leave them.
 * A record the create template cannot fill still refuses by name at emission
 * (`targets/cpp/host/emit-host-invoke.ts`'s `renderErrorCreate` checks the
 * carrier it is handed), so a nonsense assertion fails closed rather than
 * being read as a lie.
 *
 * Only an explicit assertion is read, never a declaration's annotation:
 * unlike `new Array(n)`, an error construction assigned to an annotated
 * declaration typechecks only when the annotation adds nothing, so there is
 * no second source to consult.
 */
const errorConstructResultOverride = (
  context: ProducerContext,
  node: ts.NewExpression,
  calleeUnwrapped: ts.Node
): StructuralTypeId | null => {
  if (!ts.isIdentifier(calleeUnwrapped) || !errorConstructorNames.has(calleeUnwrapped.text)) return null
  const receiverSymbol = context.checker.getSymbolAtLocation(calleeUnwrapped)
  const receiverDeclaration = receiverSymbol?.valueDeclaration
  if (
    !receiverSymbol ||
    !errorConstructorNames.has(receiverSymbol.name) ||
    !receiverDeclaration ||
    !receiverDeclaration.getSourceFile().isDeclarationFile
  ) {
    return null
  }
  const assertion = enclosingTypeAssertion(node)
  if (!assertion) return null
  return context.types.typeAt(assertion)
}

/**
 * `new Map()`/`new Set()`/`new WeakMap()`/`new WeakSet()`'s call-site override
 * -- the same shape of defect `jsonParseResultOverride` and
 * `arrayConstructResultOverride` above answer, at a family the checker
 * defaults instead of widening: a bare allocation gives `MapConstructor`'s
 * generic signature nothing to infer K/V from, so every one of these checks
 * as the SAME defaulted `Map<unknown, unknown>` (or its Set/WeakMap/WeakSet
 * siblings) regardless of what the program actually stores.
 *
 * Unlike the two overrides above, this one reads no assertion and no
 * declaration annotation of its own -- `context.collections`
 * (`normalize/collection-bindings.ts`'s whole-program census) already
 * answered the identical question for `structural.ts`'s `typeAt`
 * (`inferredCollectionTypeArgumentsAt`, `structural-array-element.ts`), which
 * is what `context.types.typeAt(node)` below already reflects for this exact
 * node. Asking `context.collections.typeArgumentsAt(node)` again here is not
 * a second, competing derivation of the narrowed type -- it is only the GATE:
 * whether this call is one `typeAt` actually narrowed, so the override (and
 * the divergence it declares) fires for exactly the calls where a real
 * disagreement exists, and stays silent -- exactly like the other two
 * overrides do when their own source is absent -- everywhere else.
 *
 * No name or symbol check of its own: `collection-bindings.ts`'s own
 * `CONSTRUCTOR_NAMES`/`constructorSymbols` already verify the callee resolves
 * to the real ambient `Map`/`Set`/`WeakMap`/`WeakSet` before binding anything,
 * so a non-null answer here is already proof of that identity -- re-deriving
 * it a second time would be the same drifting-copy risk `jsonParseResultOverride`'s
 * own comment warns about, not an extra safeguard.
 */
const collectionConstructResultOverride = (context: ProducerContext, node: ts.NewExpression): StructuralTypeId | null => {
  // The second gate is the position's own statement, asked by `typeAt` after
  // the census -- `contextualCollectionTypeAt`'s header says when it answers.
  if (!context.collections.typeArgumentsAt(node) && !contextualCollectionTypeAt(context.checker, node)) return null
  return context.types.typeAt(node)
}

/**
 * `collection.get( k )`'s call-site override -- the same collection's OTHER
 * end, and the one the construct override cannot reach.
 *
 * Narrowing the receiver's own type does nothing here: the checker types a
 * prototype call's result from the callee's signature, instantiated from the
 * receiver EXPRESSION, so `properties.get( renderTarget )` stays `any` no
 * matter what carrier this compiler selects for `properties`.
 * `structural.ts`'s `typeAt` publishes the census's `V | undefined` instead
 * (`collectionMemberResultTypeAt`, `structural-array-element.ts`), and this
 * exists so that answer does not have to agree with the separate,
 * checker-only return type `buildSelectedSignature` derives from the resolved
 * signature object.
 *
 * Like `collectionConstructResultOverride`, this is only the GATE, never a
 * second derivation: it asks the census the same question `typeAt` asked, and
 * returns `typeAt`'s own answer unchanged. The census admits only a bare `new
 * Map()`/`new WeakMap()` -- no type arguments, no constructor argument -- and
 * only answers a receiver resolving to one it bound a value for (or left
 * `value-unresolved` with evidence a later layer can lift), so a `.get` on
 * anything else records no divergence at all.
 *
 * The last of those is deliberately one step LOOSER than `typeAt`'s own rule,
 * which also requires the bag census to agree about that evidence
 * (`boundValueTypeId`, `structural-array-element.ts`). Reproducing that test
 * here would need the type table and the bag census inside a producer that
 * has neither, and re-deriving it from a copy is precisely the drifting
 * second authority these overrides exist to avoid. The cost of the looser
 * gate is a divergence recorded for a call where the two answers happened to
 * agree anyway, which `validateInvocationResult` treats as nothing to check
 * -- never a substituted type, since the type is `typeAt`'s own either way.
 */
const collectionMemberResultOverride = (context: ProducerContext, node: ts.CallExpression): StructuralTypeId | null => {
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee)) return null
  // The receiver the POSITION typed, carried to this call through a merge
  // or an assignment the checker reads dynamically -- the same gate, asked
  // of `typeAt`'s other source (`statedCollectionTypeAt`'s header).
  if (statedCollectionTypeAt(context.checker, node)) return context.types.typeAt(node)
  const member = callee.name.text
  if (member !== 'get' && member !== 'set' && member !== 'add') return null
  const bound = context.collections.typeArgumentsForRead(callee.expression)
  if (!bound) return null
  if (member === 'get' && bound.value === null && bound.valueEvidence.length === 0) return null
  return context.types.typeAt(node)
}

/**
 * A call whose result IS an object bag this census bound.
 *
 * The last of the five overrides, and the only one whose subject is not an
 * ambient global: three's `WebGLProperties.get` returns a `{}` filled a
 * property at a time, and nothing in the source states that. The bag census
 * knows all 47 members; the resolved signature knows `any`. Neither is wrong,
 * and `bag-return-inference` is the reason that lets both stand.
 *
 * The GATE only, as with the two collection overrides above: it asks the bag
 * census the same question `structural.ts`'s `typeAt` asked
 * (`bagShapeTypeAt` -> `callResultShapeAt`) and returns `typeAt`'s own answer
 * unchanged, so there is never a second derivation to drift.
 */
const bagResultOverride = (context: ProducerContext, node: ts.CallExpression | ts.NewExpression): StructuralTypeId | null => {
  if (!context.bags.callResultShapeAt(node)) return null
  return context.types.typeAt(node)
}

/**
 * Whether this call is `receiver.call(...)`/`receiver.apply(...)` with a
 * RECEIVER whose own static type carries at least one call signature --
 * the exact test `flow/callable-reach.ts`'s `unwrapExplicitThisCall` makes of
 * the identical shape, asked here for the same reason: a program is free to
 * declare its own `.call`/`.apply`-named method that has nothing to do with
 * `Function.prototype.call`/`.apply`, and only an authenticated callable
 * receiver proves this is really the ambient one.
 *
 * When it is, `structural-callable.ts`'s `createStructuralCallResultResolver`
 * is already reading the receiver's OWN call signature(s) for this call's
 * published result (wired into `context.types.typeAt` by `structural.ts`'s
 * `callResultAt`), independent of -- and more precise than -- the checker's
 * own overload-resolved `signature.getReturnType()` for `.call`/`.apply`'s
 * ambient generic signature. See `InvocationResultDivergence`'s
 * `explicit-this-call-return` for why that makes the two disagree.
 */
const isExplicitThisCallWithAuthenticatedReceiver = (context: ProducerContext, calleeUnwrapped: ts.Node): boolean => {
  if (!ts.isPropertyAccessExpression(calleeUnwrapped)) return false
  const name = calleeUnwrapped.name.text
  if (name !== 'call' && name !== 'apply') return false
  return (
    context.checker.getSignaturesOfType(context.checker.getTypeAtLocation(calleeUnwrapped.expression), ts.SignatureKind.Call).length > 0
  )
}

/** Intrinsic mutators authenticated while checker declaration identity is available. */
const intrinsicMutationOf = (
  context: ProducerContext,
  node: ts.CallExpression | ts.NewExpression,
  calleeUnwrapped: ts.Node
): InvocationOperation['intrinsicMutation'] | null => {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(calleeUnwrapped)) return null
  const member = calleeUnwrapped.name.text
  const owner = calleeUnwrapped.expression
  if (isGlobalObjectConstructor(context.checker, owner, context.checker.getTypeAtLocation(owner))) {
    if (member === 'assign') return 'object-assign'
    if (member === 'defineProperty') return 'object-define-property'
    if (member === 'defineProperties') return 'object-define-properties'
  }
  if (member === 'set' && isStandardGlobalValue(context.checker, owner, 'Reflect')) return 'reflect-set'
  return null
}

/**
 * `Object.defineProperty(globalThis, 'K', { value: V })` on the program's own
 * script `var K`, published as the store `K = V` -- see
 * `script-global-redefinition.ts` for why that is exactly what the call does.
 * The mutation census asks the same predicate and files no taint for it, so
 * the var keeps one representation and every read, bare or through
 * `globalThis`, reads the cell this writes.
 */
const contributeScriptGlobalRedefinition = (
  context: ProducerContext,
  candidate: CensusCandidate,
  node: ts.CallExpression
): CandidateContribution | null => {
  const redefinition = scriptGlobalValueRedefinitionOf(context.checker, context.unresolvableNames, node)
  if (redefinition === null) return null
  // The VALUE declaration: `type Response = ResponseImpl` beside
  // `var Response` merges into one symbol whose first declaration is the
  // alias, and a store to that id writes no cell at all.
  const declaration = context.identities.symbolValueDeclarationId(redefinition.symbol)
  if (!declaration) return null
  const { mutable, temporalDeadZone } = bindingKindOf(redefinition.declaration)
  const value = sourceForValue(context, redefinition.value)
  const type = context.types.typeAt(redefinition.declaration.name)
  const id = mintOperationId(context.ordinals, candidate.id, 'binding')
  const operation: BindingOperation = {
    id,
    family: 'binding',
    action: 'write',
    declaration,
    mutable,
    temporalDeadZone,
    caller: candidate.caller,
    operands: [operand('value', 0, value, type)],
    results: [mintResult(id, 'value', type)],
    completion: normalCompletion,
    effects: { ...pureEffects, writesMutableState: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  return {
    kind: 'operations',
    operations: [operation],
    edges: value.kind === 'result' ? [{ kind: 'value', result: value.result, to: id, role: 'value', ordinal: 0 }] : []
  }
}

/**
 * `Object.setPrototypeOf(C.prototype, B.prototype)` that
 * `prototype-reparenting.ts` models as `C` inheriting from `B`: a
 * class-lifecycle step of `C`, published where the call runs, citing the two
 * class values whose evaluations it links. The `.prototype` reads are the
 * program's own and stay with the property producer; the step needs the
 * class objects they were read from, because a class evaluation is what
 * carries its prototype.
 */
const contributePrototypeReparenting = (
  context: ProducerContext,
  candidate: CensusCandidate,
  node: ts.CallExpression
): CandidateContribution | null => {
  if (!ts.isExpressionStatement(node.parent)) return null
  const reparenting = context.prototypeReparentings.of(node)
  const [target, parent] = node.arguments
  if (!reparenting || !target || !parent) return null
  // The prototype half names both classes through `.prototype`; the
  // constructor half names them directly. Either way the operands are this
  // call's own arguments.
  const derivedValue = ts.isPropertyAccessExpression(target) ? target.expression : target
  const heritageValue = ts.isPropertyAccessExpression(target) && ts.isPropertyAccessExpression(parent) ? parent.expression : parent
  const constructorSource = sourceForValue(context, derivedValue)
  const heritageSource = sourceForValue(context, heritageValue)
  const declaration = context.identities.declarationIdOf(reparenting.derived)
  const id = mintOperationId(context.ordinals, candidate.id, 'class-lifecycle')
  const operation: ClassLifecycleOperation = {
    id,
    family: 'class-lifecycle',
    event: 'reparent-prototype',
    declaration,
    classDeclaration: declaration,
    descriptor: null,
    placement: null,
    caller: candidate.caller,
    operands: [
      operand('constructor', 0, constructorSource, context.types.typeAt(derivedValue)),
      operand('heritage', 0, heritageSource, context.types.typeAt(heritageValue))
    ],
    results: [mintResult(id, 'completion', context.table.intern({ kind: 'primitive', primitive: 'void' }))],
    // The emitted step refuses a heritage value that is not exactly `B`.
    completion: throwingCompletion,
    effects: { readsMutableState: true, writesMutableState: true, allocates: false, callsUserCode: false },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  const edges: SemanticEdge[] = []
  if (constructorSource.kind === 'result')
    edges.push({ kind: 'value', result: constructorSource.result, to: id, role: 'constructor', ordinal: 0 })
  if (heritageSource.kind === 'result') edges.push({ kind: 'value', result: heritageSource.result, to: id, role: 'heritage', ordinal: 0 })
  return { kind: 'operations', operations: [operation], edges }
}

export const createInvocationProducer = (context: ProducerContext): FamilyProducer => ({
  family: 'invocation',
  contribute: (candidate: CensusCandidate): CandidateContribution => {
    const node = candidate.node as ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression

    // A tagged template is a call, but not one this function's shape fits: its
    // callee is `node.tag` rather than `node.expression`, and its first
    // argument is a synthetic per-site object no source expression names. It
    // gets its own contributor rather than a set of special cases threaded
    // through every step below.
    if (ts.isTaggedTemplateExpression(node)) return contributeTaggedTemplate(context, candidate, node)

    const objectTag = contributeObjectTag(context, candidate, node)
    if (objectTag !== null) return objectTag

    if (ts.isCallExpression(node)) {
      const reparenting = contributePrototypeReparenting(context, candidate, node)
      if (reparenting !== null) return reparenting
    }

    if (ts.isCallExpression(node) && intrinsicMutationOf(context, node, unwrapErased(node.expression)) === 'object-define-property') {
      const redefinition = contributeScriptGlobalRedefinition(context, candidate, node)
      if (redefinition !== null) return redefinition
    }

    const args: readonly ts.Expression[] = node.arguments ?? []
    const isOptionalChain = ts.isCallExpression(node) && ts.isOptionalChain(node)
    const rawCallee = unwrapErased(node.expression)
    // `a?.()`, `a.b?.()`, and `a?.b()` all reach this producer -- the census
    // routes every `CallExpression` to `invocation` regardless of chain shape,
    // and `properties.ts`/`references.ts` only answer the *property* half of a
    // chain. Without a guard here, `a.b?.()` (only the call itself carries
    // `?.`) would fall straight through: the callee's own read is an ordinary,
    // unblocked property access, so nothing would stop this producer from
    // calling it unconditionally -- silently running the call on a
    // possibly-nullish value instead of skipping it.
    const guardExpression = isOptionalChain ? optionalCallGuardOf(node as ts.CallExpression) : null
    if (isOptionalChain && guardExpression === null) {
      return {
        kind: 'blocked',
        blocker: blocked(candidate.id, 'invocation', 'optional chaining requires short-circuit selection semantics', 'P0')
      }
    }
    const guardSource = guardExpression ? sourceForValue(context, guardExpression) : null
    // The guard has to be a value some operation publishes, because that result
    // is literally what the branch tests. A constant or a `this` guard is not
    // modelled, and inventing a test over something nothing published is how a
    // call ends up gated on a block that never runs.
    if (guardExpression !== null && guardSource?.kind !== 'result') {
      return {
        kind: 'blocked',
        blocker: blocked(
          candidate.id,
          'invocation',
          'an optional call short-circuits on a producible guard result; a constant, this, or super guard is not modelled',
          'P0'
        )
      }
    }
    const shortCircuit =
      guardExpression !== null && guardSource?.kind === 'result'
        ? { expression: guardExpression, result: guardSource.result, source: guardSource }
        : null

    const isSuperCall = ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword

    let resultDivergence: InvocationResultDivergence = isSuperCall ? { kind: 'super-constructor-initialization' } : { kind: 'none' }

    const operationIdentity = mintOperationId(context.ordinals, candidate.id, 'invocation')
    const operands: SemanticOperand[] = []

    // CommonJS is admitted by a host-authenticated AMBIENT DECLARATION, not by
    // this producer knowing a spelling.  Once admitted, the argument must be
    // static and checker-resolved: a dynamic loader is a different host
    // capability and must not accidentally become a module-record lookup.
    if (ts.isCallExpression(node) && ts.isIdentifier(rawCallee)) {
      const require = context.commonJsRequire.statusOf(rawCallee)
      if (require === 'provenance-failure') {
        return {
          kind: 'blocked',
          blocker: blocked(
            candidate.id,
            'invocation',
            'CommonJS require provenance did not resolve to the host-owned wrapper declaration',
            'P0'
          )
        }
      }
      if (require === 'possibly-reassigned') {
        return {
          kind: 'blocked',
          blocker: blocked(candidate.id, 'invocation', 'CommonJS require may have been reassigned before this call', 'P0')
        }
      }
      if (require === 'static') {
        const argument = node.arguments[0]
        if (node.arguments.length !== 1 || !argument || !ts.isStringLiteralLike(argument)) {
          return {
            kind: 'blocked',
            blocker: blocked(
              candidate.id,
              'invocation',
              'a host-authenticated CommonJS require needs exactly one static string specifier',
              'P0'
            )
          }
        }
        const targetFileName = context.runtimeModuleTargetOf(argument.text, node.getSourceFile().fileName, 'require')
        const targetFile = targetFileName === null ? null : context.sourceFileOf(targetFileName)
        if (!targetFile || targetFile.isDeclarationFile) {
          return {
            kind: 'blocked',
            blocker: blocked(candidate.id, 'invocation', 'a static CommonJS require resolved no compiled source module', 'P0')
          }
        }
        const ownerFile = node.getSourceFile()
        const owner = regionId(context.identities.nodeIdOf(ownerFile), 'module-body')
        const target = regionId(context.identities.nodeIdOf(targetFile), 'module-body')
        const nativeRecord = context.commonJsModuleRecords.requiredExportExpressionAt(node) !== null
        // A module record is the one deliberately dynamic host boundary
        // (`publish.ts`'s `commonJsBoundaryOf`), and its structural type has to
        // say so too: in checked JavaScript the checker types `require('./m')`
        // from the target's LAST `module.exports = ...`, which for a module with
        // two writers is one of two shapes and for a partially initialized
        // cycle is a shape that does not exist yet. Only the proven record
        // keeps the checker's answer.
        const resultType = nativeRecord ? context.types.typeAt(node) : context.types.typeOf(context.checker.getAnyType())
        const operation: InvocationOperation = {
          id: operationIdentity,
          family: 'invocation',
          caller: candidate.caller,
          internalMethod: 'call',
          optionalChain: false,
          selectedSignature: null,
          resultDivergence: { kind: 'none' },
          target: { kind: 'open', evidence: ['checker-authenticated CommonJS module record'] },
          commonJsRequire: {
            owner,
            target,
            builtinModule: context.builtinModuleNameOf(argument.text),
            ...(nativeRecord ? { nativeRecord: true as const } : {})
          },
          operands: [],
          results: [mintResult(operationIdentity, 'value', resultType)],
          completion: throwingCompletion,
          effects: { readsMutableState: true, writesMutableState: true, allocates: false, callsUserCode: true },
          evaluationOrdinal: candidate.evaluationOrdinal
        }
        return { kind: 'operations', operations: [operation], edges: [] }
      }
    }

    // A host may return a module selected by a runtime string.  A literal call
    // through that exact host declaration retains one real ModuleRecord;
    // nonliteral and unsupported names remain runtime lookups and can only
    // observe records the program already retained by other sound evidence.
    const builtinModuleArgument = ts.isCallExpression(node) && node.arguments.length === 1 ? node.arguments[0] : undefined
    const builtinModuleLookup =
      ts.isCallExpression(node) &&
      builtinModuleArgument &&
      ts.isStringLiteralLike(builtinModuleArgument) &&
      (ts.isPropertyAccessExpression(rawCallee) || ts.isElementAccessExpression(rawCallee))
        ? (() => {
            const method = context.hostMethodOf?.(rawCallee)
            const builtinModule = method?.builtinModuleLookup ? context.builtinModuleNameOf(builtinModuleArgument.text) : null
            if (builtinModule === null) return null
            const source = context.builtinModuleSourceOf(builtinModule)
            const targetFile = source === null ? null : context.sourceFileOf(source)
            if (!targetFile || targetFile.isDeclarationFile) {
              return { kind: 'blocked' as const, reason: `host builtin module "${builtinModule}" has no compiled runtime source record` }
            }
            return {
              kind: 'lookup' as const,
              value: { target: regionId(context.identities.nodeIdOf(targetFile), 'module-body'), builtinModule }
            }
          })()
        : null
    if (builtinModuleLookup?.kind === 'blocked') {
      return { kind: 'blocked', blocker: blocked(candidate.id, 'invocation', builtinModuleLookup.reason, 'P0') }
    }

    // Asked unconditionally, and in the SAME position it always was: this is
    // the checker's own resolved signature for the call, independent of
    // whatever `calleeType` (below) turns out to say. Keeping this call at its
    // original spot matters -- moving it around this program's tens of
    // thousands of invocations changes evaluation order for every one of
    // them, and this producer has no license to do that just to reach the one
    // override below. `ImageUtils.getDataURL` (three.js) is the concrete
    // casualty a reordered version of this fix produced: an entirely
    // unrelated static call, whose ABI flipped from `undefined` to `void` for
    // parameter 0 the moment `calleeType`'s resolution (which interns/derives
    // representation state) started running BEFORE this line instead of
    // after it. Overriding the RESULT below, rather than the ORDER here,
    // keeps every call site's evaluation identical to before except the one
    // this fix targets.
    const resolvedSignature: ts.Signature | undefined = context.checker.getResolvedSignature(node)
    // A call resolved against one declared overload of an overloaded SOURCE
    // function runs the implementation, whose frame is the only one that
    // exists: `pad("a")` resolves `(value: string): string` and invokes
    // `(value: string, width?: number): string`. Selecting the overload named
    // a body-less declaration -- so the target was never exact -- and an ABI
    // one parameter short of the body that binds two. The implementation's
    // own signature is the call's convention.
    const implementationSignature = sourceImplementationSignatureOf(context, resolvedSignature)
    let signature = implementationSignature ?? resolvedSignature
    let selectedSignature = signature ? buildSelectedSignature(context, node, signature) : null
    if (implementationSignature && resolvedSignature && selectedSignature) {
      // The implementation owns the one physical parameter frame, including
      // optional/defaulted slots omitted by a declared overload. The resolved
      // overload still owns the caller-visible result: `randomBytes(size)` is
      // `Buffer`, while the shared implementation is `Buffer | void` because
      // its callback form returns nothing. Replacing both halves with the
      // implementation signature makes the invocation producer contradict
      // the checker's selected result and, worse, loses the overload's proven
      // narrowing. Keep the implementation's frame and the resolved
      // overload's result as the two independent pieces of the call ABI.
      const resolvedSelection = buildSelectedSignature(context, node, resolvedSignature)
      if (resolvedSelection) selectedSignature = { ...selectedSignature, returnType: resolvedSelection.returnType }
    }

    // This expression's own type carries any of *its* unbound type parameters
    // -- `arr.map`'s type still has `map`'s own `<U>` free -- but it is also
    // this exact call's callee, and the checker already substituted every one
    // of those resolving this call, so `calleeAwareTypeAt` reads that answer
    // back instead of republishing the unbound one.
    // The convention this call needs, which for `host.raf?.(cb)` is the
    // callable the guard's present branch holds -- not the `fn | undefined` the
    // callee expression evaluates to. `calleeAwareTypeAt` deliberately answers
    // the second question for that shape, so the first is asked directly.
    const calleeType = resolvedCalleeSignatureType(context, node.expression) ?? calleeAwareTypeAt(context, node.expression)
    // A mutable method's cell transports every replacement's public frame;
    // the initial implementation is only one possible body in that cell.
    const mutableMethod = context.types.mutableMethodReadTypeAt(node.expression)
    const mutableFrame = mutableMethod === null ? null : structuralCallSignatures(context.table, mutableMethod)?.[0]
    if (mutableFrame && selectedSignature) {
      selectedSignature = {
        ...selectedSignature,
        parameters: mutableFrame.parameters,
        minimumArity: mutableFrame.minimumArity,
        thisParameter: mutableFrame.thisParameter
      }
    }
    // A callee `calleeType` resolved to genuinely dynamic (a bare `primitive
    // any`/`unknown`, `resolvedCalleeSignatureType`'s own two `any`/`unknown`
    // exits) is a call the checker never meaningfully typed, and
    // `getResolvedSignature` on it (above) is TypeScript's fabricated
    // zero-parameter `anySignature` -- the SAME fiction `resolvedCalleeSignatureType`
    // exists to see through for the callee's own representation, just read
    // back here from the RAW checker API a second, disagreeing way. `gl.texImage2D(...arguments)`
    // inside three.js's `WebGLState.js` (`gl` a genuinely untyped JS
    // parameter) is the concrete case: `calleeType` correctly resolves it
    // `dynamic`, but `checker.getResolvedSignature` still hands back its
    // fabricated 0-param signature, and `buildSelectedSignature` over THAT
    // produced a `SelectedSignature` with no rest formal for a call that has
    // no static arity to check in the first place -- `spread-arguments.ts`'s
    // `restFormalIndexOf` then refused a range copy into it, the same
    // "declares 0/1 parameters" fiction one layer further out. Discarding the
    // fabrication here, after the fact, keeps there from ever being two
    // authorities to disagree, without moving when either was asked.
    const calleeTypeShape = context.table.get(calleeType).shape
    const calleeIsDynamic =
      calleeTypeShape.kind === 'primitive' && (calleeTypeShape.primitive === 'any' || calleeTypeShape.primitive === 'unknown')
    const fabricatedNativeCall =
      signature !== undefined &&
      isFabricatedSignatureShape(context.checker, signature) &&
      structuralCallSignatures(context.table, calleeType) !== null
    if (calleeIsDynamic || fabricatedNativeCall) {
      signature = undefined
      selectedSignature = null
    }
    // A bare `super` keyword is not an ordinary value expression -- it is
    // grammar-restricted to `super(...)`/`super.x` positions, and citing it
    // through the ordinary `sourceForValue` path (which every ordinary callee
    // uses) throws, because no family publishes a result for a SyntaxKind the
    // language itself never lets stand alone. `super(...)`'s callee is a
    // fresh, correctly-scoped read of the base class's own name instead.
    const superRead = isSuperCall ? superConstructorRead(context, candidate, node as ts.CallExpression) : null
    if (isSuperCall && !superRead) {
      return {
        kind: 'blocked',
        blocker: blocked(
          candidate.id,
          'invocation',
          'resolving `super` needs the home object of the enclosing method, which no operation publishes',
          'P1'
        )
      }
    }
    // A call whose callee is the `?.`-carrying link of its own chain cites that
    // link's *present* value, not the value the sub-expression evaluates to.
    // The two differ exactly here: this call runs inside the guard's present
    // arm, and the `short-circuit` merge that would otherwise be cited is a phi
    // in the join block, which does not exist until both arms have closed --
    // after this call has already run. See `CitedBranch` in `references.ts`.
    const calleeBranch: CitedBranch = isOptionalChain && node.questionDotToken === undefined ? 'present' : 'expression'
    const calleeSource = superRead ? superRead.source : sourceForValue(context, node.expression, calleeBranch)
    operands.push(operand('callee', 0, calleeSource, calleeType))
    // The guard is stated as an operand rather than left for a consumer to
    // re-derive from the callee's syntax. It duplicates a value another operand
    // already evaluates -- the callee for `f?.()`, the receiver for `a?.b()` --
    // so it is provenance, and `ir/lower-short-circuit.ts` reads it to know
    // which result the merge branches on without asking the AST again.
    if (shortCircuit) operands.push(operand('short-circuit-guard', 0, shortCircuit.source, context.types.typeAt(shortCircuit.expression)))

    // `EvaluateNew` calls `Construct(constructor, argList)`, whose new-target
    // defaults to the constructor itself. Recording it explicitly rather than
    // letting a consumer assume it is what keeps a derived construction -- where
    // the two genuinely differ -- from passing as an ordinary one. It is
    // provenance, not a runtime step: the callee operand already evaluated it.
    if (ts.isNewExpression(node)) {
      operands.push(operand('new-target', 0, sourceForValue(context, node.expression), calleeType, { kind: 'provenance' }))
    }

    const calleeUnwrapped = unwrapErased(node.expression)
    // A namespace-qualified callee has no receiver: `Debug.assert(x)` calls a
    // binding, and `this` inside it is `undefined` exactly as for a bare
    // `assert(x)` (`namespace-paths.ts`). The namespace is a path, not an
    // object, so there is no value to pass.
    const qualified = ts.isPropertyAccessExpression(calleeUnwrapped) && context.namespacePaths.memberSymbolOf(calleeUnwrapped) !== null
    if (!qualified && (ts.isPropertyAccessExpression(calleeUnwrapped) || ts.isElementAccessExpression(calleeUnwrapped))) {
      // A second ?. starts after the previous chain's merge. Its receiver is
      // that merged value, while suffixes inside the same guard still cite the
      // present value. Reusing the earlier branch would violate dominance for
      // a?.b?.method(), whereas a?.b.method() stays inside a's original guard.
      const receiverBranch: CitedBranch =
        guardExpression !== null && optionalChainGuardOf(calleeUnwrapped.expression) === guardExpression ? 'present' : 'expression'
      operands.push(
        operand(
          'receiver',
          0,
          sourceForValue(context, calleeUnwrapped.expression, receiverBranch),
          context.types.typeAt(calleeUnwrapped.expression),
          {
            kind: 'provenance'
          }
        )
      )
    }

    // An optional call does not evaluate its arguments at all when the guard is
    // absent: `h.on?.(side())` never calls `side`. Recorded on the operands
    // exactly as `contributeLogical` records `a && b`'s right-hand side -- this
    // producer sees one candidate and can state what its own operands do, while
    // *placing* the argument subtree is `normalize/gating.ts`'s job, since only
    // a syntax walk knows which expressions the argument list contains.
    const argumentEvaluation: OperandEvaluation = shortCircuit
      ? { kind: 'conditional', guard: shortCircuit.result, takenWhen: 'present' }
      : { kind: 'runtime' }
    // The argument list, with the two spread shapes that settle statically
    // (a closed tuple's positional expansion, a plain array's rest-tail range
    // copy) resolved into operands. `spread-arguments.ts` owns the whole
    // decision, including the refusals, so the admission rule lives in one
    // place instead of being split between a gate here and a loop below.
    const argumentList = buildArgumentOperands(context, candidate, args, argumentEvaluation, selectedSignature, shortCircuit !== null)
    if (argumentList.kind === 'refused') {
      return { kind: 'blocked', blocker: blocked(candidate.id, 'invocation', argumentList.reason, 'P4') }
    }
    const expansions = argumentList.operations
    const expansionEdges = argumentList.edges
    operands.push(...argumentList.operands)

    // This call's own published result stays the checker's real, un-awaited
    // type -- an un-awaited async call yields a genuine `Promise<T>` value
    // now that `promise` is a real carrier
    // (`representation/derive.ts`'s `PromiseDeclarationPolicy`), not an
    // interim `T`. This used to unwrap via `getAwaitedType`, in lockstep
    // with the same reverted unwrap in `buildSelectedSignature.returnType`
    // above and `structural.ts`'s `signatureOf`. `await` unwraps at its own
    // site instead (`contributeAwait`, producers/control.ts), the only
    // place ECMAScript itself performs this unwrap. See citations.md
    // finding 2 for the reverted history.
    // `JSON.parse(text) as T` is the one call whose own published result
    // deliberately does NOT stay the checker's real type here: see
    // `jsonParseResultOverride`'s own comment (above `createInvocationProducer`)
    // for why substituting the caller's asserted type is safe for this one
    // ambient global and no other.
    const jsonParseAssertedType = jsonParseResultOverride(context, node, calleeUnwrapped)
    // `new Array(n)` is the identical shape of override, at a different
    // ambient signature -- see `arrayConstructResultOverride`'s own comment.
    // Checked only when `JSON.parse` didn't already claim this call: the two
    // receivers never overlap, but keeping the checks mutually exclusive
    // keeps `resultDivergence` from ever recording two reasons for one call.
    const arrayConstructAssertedType =
      jsonParseAssertedType === null && ts.isNewExpression(node) ? arrayConstructResultOverride(context, node, calleeUnwrapped) : null
    // `new RangeError(m) as RangeError & { code }` -- the third override of the
    // same shape. Mutually exclusive with the two above for the same reason
    // they are with each other: one call, at most one recorded divergence.
    const errorConstructAssertedType =
      jsonParseAssertedType === null && arrayConstructAssertedType === null && ts.isNewExpression(node)
        ? errorConstructResultOverride(context, node, calleeUnwrapped)
        : null
    // `new Map()`/`new Set()`/`new WeakMap()`/`new WeakSet()` -- the fourth
    // override of the same shape, at the one family the checker DEFAULTS
    // rather than widens to `any`. Mutually exclusive with the three above
    // for the same reason they are with each other: none of `JSON.parse`,
    // `new Array`, and the seven ambient error constructors is ever also a
    // keyed collection, so at most one of the four is ever recorded.
    const collectionConstructAssertedType =
      jsonParseAssertedType === null &&
      arrayConstructAssertedType === null &&
      errorConstructAssertedType === null &&
      ts.isNewExpression(node)
        ? collectionConstructResultOverride(context, node)
        : null
    // The same census at the collection's other end -- see
    // `collectionMemberResultOverride`. A `new` expression can never be a
    // `.get` call, so this stays mutually exclusive with all four above
    // without needing to test them.
    // `Object.create(null)` -- the same override at a third `any`-returning
    // ambient signature. A `new` expression can never be one, so this is
    // mutually exclusive with the three construct overrides without testing
    // them; it is checked after `JSON.parse` only because both are calls.
    const objectCreateAnnotatedType =
      jsonParseAssertedType === null && ts.isCallExpression(node) ? objectCreateResultOverride(context, node, calleeUnwrapped) : null
    const objectAssignTargetType =
      objectCreateAnnotatedType === null && ts.isCallExpression(node) ? objectAssignTargetOverride(context, node, calleeUnwrapped) : null
    // `Object.getOwnPropertyDescriptor(receiver, key)` -- the fifth override
    // of the same "checker publishes an ambient `any`-carrying signature"
    // shape. `resultType` below and `selectedSignature.returnType` (set by
    // this same `objectDescriptorReturnTypeAt` call inside
    // `buildSelectedSignature`, above) must publish the identical minted type
    // for `validateInvocationResult` to see them agree -- publishing it only
    // on one side threw exactly this "invocation result disagrees with
    // selected return type" failure and silently withheld the whole call
    // (and, transitively, the binding that cites it) the first time this was
    // wired up with the override in only one of the two places.
    const objectDescriptorAssertedType =
      objectCreateAnnotatedType === null && objectAssignTargetType === null && ts.isCallExpression(node)
        ? objectDescriptorReturnTypeAt(context, node)
        : null
    const collectionMemberInferredType =
      objectCreateAnnotatedType === null &&
      objectAssignTargetType === null &&
      objectDescriptorAssertedType === null &&
      ts.isCallExpression(node)
        ? collectionMemberResultOverride(context, node)
        : null
    // And the bag a call returns -- see `bagResultOverride`. Asked last, so a
    // `.get` on a censused collection keeps the more specific of the two
    // reasons: a bag reached through a keyed collection is the same value
    // arriving by the same call, and one call records one divergence.
    // A CONSTRUCT can name a bag for the same reason a call can -- JS returns
    // the object a constructor-invoked function returned -- so the same
    // divergence covers it. Asked here rather than left to the call arm so
    // that a bag the census resolves through `new` cannot reach the two
    // authorities with only one of them moved, which is the shape that made
    // this producer WITHHOLD when `shapeAt` answered calls unilaterally.
    const bagInferredType =
      collectionMemberInferredType === null && (ts.isCallExpression(node) || ts.isNewExpression(node))
        ? bagResultOverride(context, node)
        : null
    if (jsonParseAssertedType !== null) resultDivergence = { kind: 'json-parse-type-assertion' }
    else if (arrayConstructAssertedType !== null) resultDivergence = { kind: 'array-construct-type-annotation' }
    else if (errorConstructAssertedType !== null) resultDivergence = { kind: 'error-construct-type-assertion' }
    else if (collectionConstructAssertedType !== null) resultDivergence = { kind: 'collection-construct-type-inference' }
    else if (objectCreateAnnotatedType !== null) resultDivergence = { kind: 'object-create-type-annotation' }
    else if (objectAssignTargetType !== null) resultDivergence = { kind: 'object-assign-target-identity' }
    else if (collectionMemberInferredType !== null) resultDivergence = { kind: 'collection-member-type-inference' }
    else if (bagInferredType !== null) resultDivergence = { kind: 'bag-return-inference' }
    // Neither override, and no type is substituted: the published result stays
    // the checker's own `unique symbol`. Only the LICENSE is recorded, because
    // the two types are the one `{ kind: 'symbol' }` carrier physically and
    // there is nothing for a consumer to choose between.
    else if (isUniqueSymbolFreshType(context.checker, node, signature)) resultDivergence = { kind: 'unique-symbol-fresh-type' }
    // `Array.of.call(Pack, ...)` / `Array.prototype.map.call(arrayLike, fn)`:
    // no type is substituted here either -- `resultType` below already falls
    // back to `context.types.typeAt(node)`, which `callResultAt` (structural.ts)
    // already corrected -- only the LICENSE for that correction disagreeing
    // with `.call`/`.apply`'s own ambient signature is recorded.
    else if (ts.isCallExpression(node) && isExplicitThisCallWithAuthenticatedReceiver(context, calleeUnwrapped))
      resultDivergence = { kind: 'explicit-this-call-return' }
    // The ninth shape of "the checker published an ambient `any` and the
    // census knows better", and the only one where the better answer is the
    // CALLEE'S OWN, already selected, already published.
    //
    // A receiver the census resolved is one the checker did not. Three reaches
    // `renderer.state.buffers.depth.getReversed()` through `_this.state =
    // state`, where `state` is the classic `let state; state = new
    // WebGLState( ... )` hoist: every link types here -- the operand carrier is
    // a `native-record-ref` and the callee's is `callable( -> scalar)` -- and
    // then the RESULT was published `dynamic`, because `typeAt( node )` asks
    // the checker, for whom `renderer.state` is `any`. One cell, two answers,
    // and the emitter boxes a scalar it is already calling through an ABI that
    // returns one.
    //
    // Taking the signature's return here is not a new claim: it is the type
    // this call was already selected to produce, so `validateInvocationResult`
    // sees the two agree and no divergence license is needed -- the other
    // eight overrides need one precisely because they disagree with their
    // signature, and this one does not.
    //
    // Narrow deliberately. The fabricated `anySignature` is already discarded
    // above (`calleeIsDynamic || fabricatedNativeCall` nulls
    // `selectedSignature`), so a signature that survives is a real one; a
    // signature returning `any`/`unknown` states nothing to prefer; and an
    // optional call is left alone, because there the node's own `T | undefined`
    // is the whole expression's real type and the signature's bare `T` would
    // silently strip the absent branch the guard exists for.
    const checkerResultType = context.types.typeAt(node)
    const publishesNothing = (candidateType: StructuralTypeId): boolean => {
      const shape = context.table.get(candidateType)?.shape
      return shape?.kind === 'primitive' && (shape.primitive === 'any' || shape.primitive === 'unknown')
    }
    // `selectedSignature` is the CHECKER's answer, and the checker is exactly
    // the authority that failed here: it resolves no signature through a
    // receiver it types `any`, so for the shape this override exists for it is
    // usually null while the callee's own CARRIER is a fully typed
    // `callable( -> scalar)`. Fall back to that carrier's signature -- the one
    // the emitter will actually call through, and the one
    // `fabricatedNativeCall` above already treats as the true authority when
    // the checker's disagrees. Only when the checker selected nothing, so the
    // two can never be published disagreeing; and only for a CALL, since a
    // `new` names construct signatures these are not.
    const carriedReturnType =
      selectedSignature === null && ts.isCallExpression(node)
        ? (structuralCallSignatures(context.table, calleeType)?.[0]?.result ?? null)
        : null
    const censusedCandidate = selectedSignature !== null ? selectedSignature.returnType : carriedReturnType
    const censusedReturnType =
      censusedCandidate !== null && !shortCircuit && publishesNothing(checkerResultType) && !publishesNothing(censusedCandidate)
        ? censusedCandidate
        : null
    const resultType =
      jsonParseAssertedType ??
      arrayConstructAssertedType ??
      errorConstructAssertedType ??
      collectionConstructAssertedType ??
      objectCreateAnnotatedType ??
      objectAssignTargetType ??
      objectDescriptorAssertedType ??
      collectionMemberInferredType ??
      bagInferredType ??
      censusedReturnType ??
      checkerResultType
    // `a?.b()` is typed `T | undefined` by the checker, and both halves are
    // needed: the whole expression really is that union, while the `[[Call]]`
    // inside it returns a `T` and never an `undefined` -- it does not run at
    // all on the branch where the guard was absent. The selected signature's
    // own return type is that `T`, asked rather than reconstructed; a call
    // whose overload set the checker withheld has no such answer, and stripping
    // nullability off the node's type instead would also strip a `T` that
    // genuinely includes `undefined`, so that shape stays refused by name.
    // Unless the whole expression is `any`, in which case there is nothing to
    // strip and no signature to need. `hello?.hosts?.map(...)` is the shape --
    // `hello: Document | undefined`, `hosts` reached through `Document`'s
    // `[key: string]: any` index signature, so the callee is `any` and the
    // checker resolves no signature because there is none to resolve. The
    // reasoning above does not apply to it: `any | undefined` IS `any`, so
    // publishing the node's own type strips nothing, and the program asked for
    // a dynamic value by declaring the index `any`. Refusing instead denied a
    // carrier to four `ServerDescription` fields and bson's whole
    // startup-snapshot probe, whose calls are `@ts-expect-error`-marked
    // optional APIs precisely because nothing declares them.
    const publishedShape = context.table.get(resultType)?.shape
    const publishesDynamic = publishedShape?.kind === 'primitive' && publishedShape.primitive === 'any'
    if (shortCircuit && !selectedSignature && !publishesDynamic) {
      return {
        kind: 'blocked',
        blocker: blocked(
          candidate.id,
          'invocation',
          'an optional call publishes the value its signature returns, and no signature resolved for this call',
          'P0'
        )
      }
    }
    // Never clobbers the two override divergences above: `shortCircuit` is only
    // ever set for an optional CALL, and both overrides are `new` expressions or
    // an ambient `JSON.parse` receiver, neither of which can be an optional
    // chain. So at most one of the three reasons is ever recorded for one call.
    if (shortCircuit) resultDivergence = { kind: 'optional-call-short-circuit' }
    if (selectedSignature) validateInvocationResult(selectedSignature, resultType, resultDivergence)

    const intrinsicMutation = intrinsicMutationOf(context, node, calleeUnwrapped)
    const intrinsicPropertyCall = intrinsicPropertyCallOf(context, node, calleeUnwrapped)
    const operation: InvocationOperation = {
      id: operationIdentity,
      family: 'invocation',
      caller: candidate.caller,
      internalMethod: ts.isNewExpression(node) ? 'construct' : 'call',
      optionalChain: isOptionalChain,
      selectedSignature,
      resultDivergence,
      target: buildTarget(context, node, signature),
      ...(builtinModuleLookup?.kind === 'lookup' ? { builtinModuleLookup: builtinModuleLookup.value } : {}),
      ...(intrinsicMutation ? { intrinsicMutation } : {}),
      ...(intrinsicPropertyCall === 'own-keys' ? { intrinsicOwnKeys: true as const } : {}),
      ...(intrinsicPropertyCall === 'define-property' ? { intrinsicDataDefinition: true as const } : {}),
      ...(intrinsicPropertyCall === 'carrier-predicate' ? { intrinsicCarrierPredicate: true as const } : {}),
      ...(intrinsicPropertyCall === 'get' ||
      intrinsicPropertyCall === 'set' ||
      intrinsicPropertyCall === 'has' ||
      intrinsicPropertyCall === 'deleteProperty' ||
      intrinsicPropertyCall === 'getOwnPropertyDescriptor'
        ? { intrinsicReflection: intrinsicPropertyCall }
        : {}),
      operands,
      conversionRoles: [
        ...argumentConversionRolesOf(selectedSignature, operands),
        ...exactArmArgumentRolesOf(context, node, resolvedSignature, implementationSignature, operands)
      ],
      // Two results, and they are different values. `value` is what the call
      // returned, which exists only on the branch where the guard was present;
      // `short-circuit` is what the *expression* evaluates to, which is that
      // return value on one branch and `undefined` on the other. A consumer of
      // `a?.b()` wants the second -- that is the operator's whole meaning --
      // and the first is what `[[Call]]` itself produced, which nothing outside
      // the present branch may read.
      results: shortCircuit
        ? [
            // A genuinely dynamic optional call has no resolved signature,
            // but it still has the same two runtime values: the call result
            // on the present branch and the whole expression after merging
            // with `undefined`. `any` absorbs that absent arm statically, so
            // both results use `resultType`; omitting the second result leaves
            // every consumer citing a value no producer publishes.
            mintResult(operationIdentity, 'value', selectedSignature?.returnType ?? resultType),
            mintResult(operationIdentity, 'short-circuit', resultType)
          ]
        : [mintResult(operationIdentity, 'value', resultType)],
      completion: throwingCompletion,
      // Any call can run arbitrary code, so purity, read, and write are all
      // conservatively true; nothing downstream may assume otherwise.
      effects: { readsMutableState: true, writesMutableState: true, allocates: ts.isNewExpression(node), callsUserCode: true },
      // Evaluation position comes from the shared per-caller counter, never
      // from a source offset: the two are not comparable, so an operation
      // ordinalled by offset sorts before every operation ordinalled by count
      // regardless of the order either actually runs in.
      evaluationOrdinal: candidate.evaluationOrdinal
    }

    // The `[[Call]]` runs only where the guard is present. Stating that as a
    // conditional edge rather than as a flag on the operation is what lets one
    // machinery serve `if (a)`, `a && b`, `a?.b` and `a?.b()`: all four are a
    // guard, a gated region, and a join, and only the question asked of the
    // guard differs. This edge places the call itself; the argument subtree is
    // placed by `normalize/gating.ts`, which walks the syntax the arguments
    // are written in.
    const shortCircuitEdges: readonly SemanticEdge[] = shortCircuit
      ? [{ kind: 'conditional', guard: shortCircuit.result, to: operationIdentity, takenWhen: 'present' }]
      : []
    const valueEdges = valueEdgesInto(operationIdentity, operands)
    // The expanded tuple-spread reads are published with the call that cites
    // them: `contribution.ts` commits one candidate atomically, so operands
    // naming results from a separately-committed candidate would be withheld
    // the moment that candidate were blocked.
    return {
      kind: 'operations',
      operations: superRead ? [...superRead.operations, ...expansions, operation] : [...expansions, operation],
      edges: superRead
        ? [...superRead.edges, ...expansionEdges, ...valueEdges, ...shortCircuitEdges]
        : [...expansionEdges, ...valueEdges, ...shortCircuitEdges]
    }
  }
})
