import type { DeclarationId, FunctionId, IrValueId, PhysicalBodyId, RegionId, SemanticResultId } from '../identity/ids.js'
import { irValueId } from '../identity/ids.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import type { ConstantLiteral } from '../semantics/model/operands.js'
import type { SemanticTargetProof } from '../semantics/model/operations.js'
import type { HostMethodBinding } from '../semantics/host-methods.js'
import type { TypedComputedReadRecipe, TypedComputedWriteRecipe } from './typed-property-access.js'
import { irBlockId } from './model.js'
import { successorsOfTerminator } from './queries.js'
import type {
  CallOperation,
  ComputeOperation,
  ConversionUseId,
  ElementOperation,
  GetIteratorOperation,
  IrArrayElement,
  IrBlock,
  IrBlockId,
  IrBody,
  IrNonTerminatorOperation,
  IrOperand,
  IrPhiIncoming,
  IrPropertyAttributes,
  IrRecordFieldInit,
  IrResult,
  IrSwitchCase,
  IrTemplateCookedSegment,
  IrTerminatorOperation,
  IrTryRegion,
  IrIteratorCloseRegion
} from './model.js'
import { verifyIrBody } from './verify.js'
import { nativeEqualityOf } from './native-equality.js'
import { nativeMergeTransportOf } from './native-merge-transport.js'
import type { ConversionCensus } from '../conversion/nodes.js'

/**
 * The IR body builder.
 *
 * One factory call owns one physical body's mutable construction state --
 * blocks under construction, the SSA id counter, and the value/representation
 * index -- and nothing here is module-level, so two bodies being built
 * concurrently cannot see each other's state. There is one method per
 * operation kind rather than one generic "append" call, so a caller cannot
 * assemble a malformed operation (a `get` missing its key, a `call` with the
 * wrong argument shape): the id is minted here, at the one point the caller
 * commits to a representation, and handed back already attached to the
 * operation it belongs to.
 *
 * `seal` is the only way to obtain a body, and it always runs `verifyIrBody`
 * first. A builder that could hand out an unverified body would make every
 * caller responsible for remembering to verify, which is exactly the kind of
 * optional safety step this architecture rejects.
 */
export interface IrBodyBuilder {
  readonly openBlock: () => IrBlockId

  readonly get: (
    block: IrBlockId,
    lineage: SemanticResultId,
    receiver: IrOperand,
    key: IrOperand,
    representation: Representation,
    hostMethod?: HostMethodBinding,
    /** See `GetOperation.reactive`. */
    reactive?: boolean,
    /** See `GetOperation.callableOwnPrototype`. */
    callableOwnPrototype?: boolean,
    /** See `GetOperation.normalResult`. */
    normalResult?: 'undefined',
    /** See `GetOperation.typedComputedRead`. */
    typedComputedRead?: TypedComputedReadRecipe,
    /** See `GetOperation.provenKeyTexts`. */
    provenKeyTexts?: readonly string[]
  ) => IrValueId
  readonly set: (
    block: IrBlockId,
    lineage: SemanticResultId,
    receiver: IrOperand,
    key: IrOperand,
    value: IrOperand,
    strict: boolean,
    representation: Representation | null,
    /** See `SetOperation.typedComputedWrite`. */
    typedComputedWrite?: TypedComputedWriteRecipe,
    /** See `SetOperation.provenKeyTexts`. */
    provenKeyTexts?: readonly string[]
  ) => IrValueId | null
  readonly delete: (
    block: IrBlockId,
    lineage: SemanticResultId,
    receiver: IrOperand,
    key: IrOperand,
    strict: boolean,
    representation: Representation | null
  ) => IrValueId | null
  readonly hasProperty: (
    block: IrBlockId,
    lineage: SemanticResultId,
    receiver: IrOperand,
    key: IrOperand,
    representation: Representation
  ) => IrValueId
  readonly ownPropertyKeys: (block: IrBlockId, lineage: SemanticResultId, receiver: IrOperand, representation: Representation) => IrValueId
  readonly defineOwnProperty: (
    block: IrBlockId,
    lineage: SemanticResultId,
    receiver: IrOperand,
    key: IrOperand,
    value: IrOperand,
    attributes: IrPropertyAttributes,
    representation: Representation | null
  ) => IrValueId | null
  /**
   * Object spread's `CopyDataProperties` for a source with no statically
   * known own-property set. See `SpreadCopyOperation` (model.ts). No result:
   * `CopyDataProperties` publishes nothing a JS consumer ever reads.
   */
  readonly spreadCopy: (block: IrBlockId, lineage: SemanticResultId, receiver: IrOperand, source: IrOperand) => void

  readonly call: (
    block: IrBlockId,
    lineage: SemanticResultId,
    callee: IrOperand,
    receiver: IrOperand | null,
    args: readonly IrOperand[],
    representation: Representation | null,
    family?: CallOperation['family'],
    builtinModuleLookup?: CallOperation['builtinModuleLookup'],
    argumentsAreSpread?: boolean,
    intrinsicOwnKeys?: true,
    fixedDataDefinition?: CallOperation['fixedDataDefinition'],
    numericRestHostCall?: CallOperation['numericRestHostCall'],
    objectValueConversions?: CallOperation['objectValueConversions'],
    intrinsicCarrierPredicate?: true,
    intrinsicReflection?: CallOperation['intrinsicReflection'],
    hostTemplate?: CallOperation['hostTemplate']
  ) => IrValueId | null
  readonly commonJsRequire: (
    block: IrBlockId,
    lineage: SemanticResultId,
    owner: RegionId,
    target: RegionId,
    builtinModule: string | null,
    representation: Representation
  ) => IrValueId
  readonly commonJsBinding: (
    block: IrBlockId,
    lineage: SemanticResultId,
    global: 'require' | 'exports' | 'module',
    owner: RegionId,
    representation: Representation
  ) => IrValueId
  readonly commonJsBindingSet: (
    block: IrBlockId,
    lineage: SemanticResultId,
    global: 'require' | 'exports' | 'module',
    owner: RegionId,
    value: IrOperand
  ) => void
  readonly superInitialize: (block: IrBlockId, lineage: SemanticResultId, args: readonly IrOperand[]) => void
  readonly reparentConstructor: (
    block: IrBlockId,
    lineage: SemanticResultId,
    derived: DeclarationId,
    base: DeclarationId,
    classValue: IrOperand,
    heritage: IrOperand
  ) => void
  readonly construct: (
    block: IrBlockId,
    lineage: SemanticResultId,
    callee: IrOperand,
    newTarget: IrOperand,
    target: SemanticTargetProof,
    args: readonly IrOperand[],
    representation: Representation,
    /** `ConstructOperation.hostFrame`: the site's selected host-constructor frame, where one was derived. */
    hostFrame?: CallableAbi
  ) => IrValueId

  readonly constant: (
    block: IrBlockId,
    lineage: SemanticResultId,
    text: string,
    literal: ConstantLiteral,
    representation: Representation
  ) => IrValueId
  readonly bindingRead: (
    block: IrBlockId,
    lineage: SemanticResultId,
    declaration: DeclarationId,
    representation: Representation,
    /** See `BindingReadOperation.reactive`. */
    reactive?: boolean
  ) => IrValueId
  readonly bindingWrite: (block: IrBlockId, lineage: SemanticResultId, declaration: DeclarationId, value: IrOperand) => void
  readonly parameter: (block: IrBlockId, lineage: SemanticResultId, ordinal: number, representation: Representation) => IrValueId
  readonly receiver: (block: IrBlockId, lineage: SemanticResultId, representation: Representation) => IrValueId
  readonly globalThis: (block: IrBlockId, lineage: SemanticResultId, representation: Representation) => IrValueId
  readonly unresolvableReference: (block: IrBlockId, lineage: SemanticResultId, representation: Representation) => IrValueId
  /**
   * `await`. `representation` is the awaited *result's* carrier (the payload
   * an `await` expression evaluates to), not the operand's -- exactly the
   * `IrResult | null` split `call` already uses, for the identical reason: a
   * `Promise<void>` payload publishes no SSA id at all.
   */
  readonly await: (
    block: IrBlockId,
    lineage: SemanticResultId,
    operand: IrOperand,
    representation: Representation | null
  ) => IrValueId | null
  /**
   * `co_yield`. `representation` is the RESUME value's carrier -- what the
   * yield expression itself evaluates to, mirroring `await`'s own split --
   * and is `null` only when this generator's `TNext` never resolved to a
   * native carrier (`YieldOperation`'s own doc comment, model.ts).
   */
  readonly yield: (
    block: IrBlockId,
    lineage: SemanticResultId,
    operand: IrOperand | null,
    representation: Representation | null
  ) => IrValueId | null
  /** The value a native `catch` clause binds. See `CatchBindingOperation`. */
  readonly catchBinding: (block: IrBlockId, lineage: SemanticResultId, representation: Representation) => IrValueId
  readonly compute: (
    block: IrBlockId,
    lineage: SemanticResultId,
    form: ComputeOperation['form'],
    operator: string,
    operands: readonly IrOperand[],
    representation: Representation
  ) => IrValueId
  readonly phi: (
    block: IrBlockId,
    lineage: SemanticResultId,
    incoming: readonly IrPhiIncoming[],
    representation: Representation
  ) => IrValueId
  /**
   * Whether a block already carries a terminator.
   *
   * The one authority on it. Callers used to keep a flag beside their own
   * "current block" and set it as they moved, which is two answers to one
   * question -- and the moment the two disagreed (a frame closing into a block
   * that was already terminated, which cleared the flag anyway) the second
   * terminator was refused here, frames away from where the flag drifted.
   */
  readonly isTerminated: (block: IrBlockId) => boolean
  readonly branch: (block: IrBlockId, lineage: SemanticResultId, condition: IrOperand, whenTrue: IrBlockId, whenFalse: IrBlockId) => void
  /**
   * `lineage` is `null` only for a transfer no semantic result authored: the
   * entry edge into a loop header exists because the loop's shape needs it, not
   * because some operation published it, and naming a nearby result would
   * attribute a jump to an operation that did not ask for one.
   */
  readonly jump: (block: IrBlockId, lineage: SemanticResultId | null, target: IrBlockId) => void
  /**
   * `lineage` is `null` only for the terminator that closes a body ending
   * implicitly -- a module body has no `return` statement, so there is no
   * semantic operation for its end to cite, and inventing one would attribute
   * the close to work that did not produce it.
   */
  readonly return: (block: IrBlockId, lineage: SemanticResultId | null, value: IrOperand | null) => void
  readonly throw: (block: IrBlockId, lineage: SemanticResultId, value: IrOperand) => void
  readonly switch: (
    block: IrBlockId,
    lineage: SemanticResultId,
    discriminant: IrOperand,
    cases: readonly IrSwitchCase[],
    defaultTarget: IrBlockId
  ) => void

  readonly allocateOrdinaryObject: (block: IrBlockId, lineage: SemanticResultId, representation: Representation) => IrValueId
  readonly allocateArrayObject: (
    block: IrBlockId,
    lineage: SemanticResultId,
    elements: readonly IrArrayElement[],
    representation: Representation
  ) => IrValueId
  readonly allocateCallable: (
    block: IrBlockId,
    lineage: SemanticResultId,
    functionId: FunctionId,
    captures: readonly IrOperand[],
    representation: Representation
  ) => IrValueId
  readonly bindCallable: (
    block: IrBlockId,
    lineage: SemanticResultId,
    source: IrOperand,
    sourceFunctionId: FunctionId | null,
    sourceAbi: CallableAbi,
    thisArgument: IrOperand | null,
    receiver: IrOperand | null,
    bound: readonly IrOperand[],
    representation: Representation,
    detached?: boolean
  ) => IrValueId
  readonly allocateConstructor: (
    block: IrBlockId,
    lineage: SemanticResultId,
    declaration: DeclarationId,
    captures: readonly IrOperand[],
    representation: Representation,
    heritage?: IrOperand
  ) => IrValueId
  readonly allocateProxy: (
    block: IrBlockId,
    lineage: SemanticResultId,
    target: IrOperand,
    handler: IrOperand,
    representation: Representation
  ) => IrValueId
  readonly allocateRecord: (
    block: IrBlockId,
    lineage: SemanticResultId,
    fields: readonly IrRecordFieldInit[],
    representation: Representation
  ) => IrValueId
  readonly allocateTemplateObject: (
    block: IrBlockId,
    lineage: SemanticResultId,
    cooked: readonly IrTemplateCookedSegment[],
    raw: readonly string[],
    representation: Representation
  ) => IrValueId
  readonly allocateRegExp: (
    block: IrBlockId,
    lineage: SemanticResultId,
    source: string,
    flags: string,
    representation: Representation
  ) => IrValueId

  readonly element: (
    block: IrBlockId,
    lineage: SemanticResultId,
    form: ElementOperation['form'],
    tag: IrOperand | null,
    representation: Representation,
    /** Whether this element IS its text rather than containing it -- see `ElementOperation.textLeaf`. */
    textLeaf: boolean
  ) => IrValueId
  /** Set one property on a node already created. */
  readonly elementProp: (block: IrBlockId, lineage: SemanticResultId, node: IrOperand, key: IrOperand, value: IrOperand) => void
  /** Attach one child to a node already created. */
  readonly elementChild: (block: IrBlockId, lineage: SemanticResultId, node: IrOperand, child: IrOperand, textLeaf: boolean) => void

  /** `ToBoolean` of a value, for the conditional that has to branch on it. The result is a boolean scalar by construction. */
  readonly test: (
    block: IrBlockId,
    lineage: SemanticResultId,
    value: IrOperand,
    predicate?: 'to-boolean' | 'is-present' | 'is-defined'
  ) => IrValueId
  readonly convert: (
    block: IrBlockId,
    lineage: SemanticResultId,
    conversionUse: ConversionUseId,
    source: IrOperand,
    representation: Representation
  ) => IrValueId
  /** See `MergeLiveArmRebuildOperation` -- the control-flow-proven live-arm sibling of representation-global `convert`. */
  readonly mergeLiveArmRebuild: (
    block: IrBlockId,
    lineage: SemanticResultId,
    source: IrOperand,
    representation: Representation,
    liveArms: readonly number[],
    sourceAbsenceLive: boolean,
    conversions: ConversionCensus
  ) => IrValueId

  readonly getIterator: (
    block: IrBlockId,
    lineage: SemanticResultId,
    protocol: GetIteratorOperation['protocol'],
    receiver: IrOperand,
    method: IrOperand | null,
    representation: Representation
  ) => IrValueId
  readonly iteratorNext: (
    block: IrBlockId,
    lineage: SemanticResultId,
    iterator: IrOperand,
    value: IrOperand | null,
    representation: Representation
  ) => IrValueId
  /** `IteratorResult`'s `done` half -- see `IteratorDoneOperation`'s own comment (ir/model.ts) for why this is a separate op rather than a second result on `iteratorNext`. */
  readonly iteratorDone: (block: IrBlockId, lineage: SemanticResultId, iterator: IrOperand, representation: Representation) => IrValueId
  readonly iteratorClose: (
    block: IrBlockId,
    lineage: SemanticResultId,
    iterator: IrOperand,
    representation: Representation | null,
    onlyIfOpen: boolean
  ) => IrValueId | null
  /** Current creation order, used to seal source-level cleanup regions without re-deriving block ordinals. */
  readonly blockOrder: () => readonly IrBlockId[]

  /**
   * A block's current successors, so a caller sealing a SINGLE-ENTRY cleanup
   * region can close that region's membership over the graph rather than over
   * the operations its blocks happen to carry. A join or an empty `else` arm
   * carries no operation at all and is therefore named by no per-operation
   * scan, while its only predecessor and its only successor are both inside
   * the region -- which is the shape that renders as a `goto` from outside a
   * C++ try block into it.
   */
  readonly successorsOfBlock: (block: IrBlockId) => readonly IrBlockId[]

  /**
   * Verify and freeze. Throws, naming every violation, rather than hand back
   * a body that failed a guard.
   *
   * `tryRegions` is supplied here rather than accumulated internally: the flow
   * controller that opens a region's blocks lives in `lower-flow.ts`, outside
   * this builder, exactly as the guard/loop caches it also owns do -- `seal`
   * is simply where the two halves of one body's construction state come
   * together into the frozen result.
   */
  readonly seal: (tryRegions?: readonly IrTryRegion[], iteratorCloseRegions?: readonly IrIteratorCloseRegion[]) => IrBody
}

interface MutableBlock {
  readonly id: IrBlockId
  readonly operations: IrNonTerminatorOperation[]
  terminator: IrTerminatorOperation | null
}

export const createIrBodyBuilder = (
  owner: PhysicalBodyId,
  sourceOwner: FunctionId | RegionId,
  abi: CallableAbi | null,
  constructAbi: CallableAbi | null = null
): IrBodyBuilder => {
  const blocks = new Map<IrBlockId, MutableBlock>()
  const order: IrBlockId[] = []
  const values = new Map<IrValueId, Representation>()
  let entry: IrBlockId | null = null
  let blockOrdinal = 0
  let valueOrdinal = 0
  let sealed = false

  const successorsOfBlock = (block: IrBlockId): readonly IrBlockId[] => {
    const found = blocks.get(block)
    return found?.terminator ? successorsOfTerminator(found.terminator) : []
  }

  const requireOpen = (): void => {
    if (sealed) throw new Error(`IR body builder for ${owner} is sealed; further mutation would create a second answer`)
  }

  const requireBlock = (block: IrBlockId): MutableBlock => {
    const found = blocks.get(block)
    if (!found) throw new Error(`block ${block} was never opened by this builder`)
    return found
  }

  const mintValue = (representation: Representation): IrValueId => {
    requireOpen()
    const id = irValueId(owner, valueOrdinal)
    valueOrdinal += 1
    values.set(id, representation)
    return id
  }

  const mintResult = (representation: Representation): IrResult => ({ id: mintValue(representation), representation })

  /**
   * `void` is a completed evaluation with no value, not a value of some empty
   * type: it has no physical carrier, so there is no SSA id to mint for it and
   * no local to declare. Answering that here, once, is what keeps the rule
   * single: an operation whose declared result is `void` publishes no result,
   * exactly as `CallOperation.result` documents, and any later reader of that
   * result is refused for citing a value that was never produced rather than
   * being handed a local with no type.
   */
  const mintOptionalResult = (representation: Representation | null): IrResult | null =>
    representation && representation.kind !== 'void' ? mintResult(representation) : null

  /**
   * A block's terminator is stored beside its operation list, not in it, so an
   * operation appended to a terminated block still runs before that terminator.
   * That is what a merge needs: one arm can be closed while the value the other
   * arm contributes is still being materialized, and forcing the caller to
   * order the two would put block bookkeeping in the caller instead of here.
   * Appending a *second* terminator remains an error.
   */
  const append = (block: IrBlockId, operation: IrNonTerminatorOperation): void => {
    requireOpen()
    requireBlock(block).operations.push(operation)
  }

  const isTerminated = (block: IrBlockId): boolean => requireBlock(block).terminator !== null

  const terminate = (block: IrBlockId, terminator: IrTerminatorOperation): void => {
    requireOpen()
    const found = requireBlock(block)
    if (found.terminator)
      throw new Error(
        `block ${block} is already terminated by a ${found.terminator.kind} operation; cannot terminate again with ${terminator.kind}`
      )
    found.terminator = terminator
  }

  const openBlock = (): IrBlockId => {
    requireOpen()
    const id = irBlockId(owner, blockOrdinal)
    blockOrdinal += 1
    blocks.set(id, { id, operations: [], terminator: null })
    order.push(id)
    if (entry === null) entry = id
    return id
  }

  const get: IrBodyBuilder['get'] = (
    block,
    lineage,
    receiver,
    key,
    representation,
    hostMethod,
    reactive,
    callableOwnPrototype,
    normalResult,
    typedComputedRead,
    provenKeyTexts
  ) => {
    const result = mintResult(representation)
    append(block, {
      kind: 'get',
      lineage,
      receiver,
      key,
      result,
      ...(hostMethod ? { hostMethod } : {}),
      ...(reactive ? { reactive } : {}),
      ...(callableOwnPrototype === undefined ? {} : { callableOwnPrototype }),
      ...(normalResult === undefined ? {} : { normalResult }),
      ...(typedComputedRead === undefined ? {} : { typedComputedRead }),
      ...(provenKeyTexts === undefined ? {} : { provenKeyTexts })
    })
    return result.id
  }

  const set: IrBodyBuilder['set'] = (block, lineage, receiver, key, value, strict, representation, typedComputedWrite, provenKeyTexts) => {
    const result = mintOptionalResult(representation)
    append(block, {
      kind: 'set',
      lineage,
      receiver,
      key,
      value,
      strict,
      result,
      ...(typedComputedWrite === undefined ? {} : { typedComputedWrite }),
      ...(provenKeyTexts === undefined ? {} : { provenKeyTexts })
    })
    return result?.id ?? null
  }

  const deleteProperty: IrBodyBuilder['delete'] = (block, lineage, receiver, key, strict, representation) => {
    const result = mintOptionalResult(representation)
    append(block, { kind: 'delete', lineage, receiver, key, strict, result })
    return result?.id ?? null
  }

  const hasProperty: IrBodyBuilder['hasProperty'] = (block, lineage, receiver, key, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'has-property', lineage, receiver, key, result })
    return result.id
  }

  const ownPropertyKeys: IrBodyBuilder['ownPropertyKeys'] = (block, lineage, receiver, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'own-property-keys', lineage, receiver, result })
    return result.id
  }

  const defineOwnProperty: IrBodyBuilder['defineOwnProperty'] = (block, lineage, receiver, key, value, attributes, representation) => {
    const result = mintOptionalResult(representation)
    append(block, { kind: 'define-own-property', lineage, receiver, key, value, attributes, result })
    return result?.id ?? null
  }

  const spreadCopy: IrBodyBuilder['spreadCopy'] = (block, lineage, receiver, source) => {
    append(block, { kind: 'spread-copy', lineage, receiver, source })
  }

  const call: IrBodyBuilder['call'] = (
    block,
    lineage,
    callee,
    receiver,
    args,
    representation,
    family,
    builtinModuleLookup,
    argumentsAreSpread,
    intrinsicOwnKeys,
    fixedDataDefinition,
    numericRestHostCall,
    objectValueConversions,
    intrinsicCarrierPredicate,
    intrinsicReflection,
    hostTemplate
  ) => {
    const result = mintOptionalResult(representation)
    append(block, {
      kind: 'call',
      lineage,
      callee,
      receiver,
      arguments: args,
      result,
      ...(family ? { family } : {}),
      ...(builtinModuleLookup ? { builtinModuleLookup } : {}),
      ...(argumentsAreSpread ? { argumentsAreSpread } : {}),
      ...(numericRestHostCall ? { numericRestHostCall } : {}),
      ...(objectValueConversions?.length ? { objectValueConversions } : {}),
      ...(intrinsicOwnKeys ? { intrinsicOwnKeys } : {}),
      ...(intrinsicCarrierPredicate ? { intrinsicCarrierPredicate } : {}),
      ...(intrinsicReflection ? { intrinsicReflection } : {}),
      ...(hostTemplate ? { hostTemplate } : {}),
      ...(fixedDataDefinition ? { fixedDataDefinition } : {})
    })
    return result?.id ?? null
  }

  const commonJsRequire: IrBodyBuilder['commonJsRequire'] = (block, lineage, owner, target, builtinModule, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'commonjs-require', lineage, owner, target, builtinModule, result })
    return result.id
  }
  const commonJsBinding: IrBodyBuilder['commonJsBinding'] = (block, lineage, global, owner, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'commonjs-binding', lineage, global, owner, result })
    return result.id
  }
  const commonJsBindingSet: IrBodyBuilder['commonJsBindingSet'] = (block, lineage, global, owner, value) => {
    append(block, { kind: 'commonjs-binding-set', lineage, global, owner, value })
  }

  const superInitialize: IrBodyBuilder['superInitialize'] = (block, lineage, args) => {
    append(block, { kind: 'super-initialize', lineage, arguments: args })
  }

  const reparentConstructor: IrBodyBuilder['reparentConstructor'] = (block, lineage, derived, base, classValue, heritage) => {
    append(block, { kind: 'reparent-constructor', lineage, derived, base, classValue, heritage })
  }

  const construct: IrBodyBuilder['construct'] = (block, lineage, callee, newTarget, target, args, representation, hostFrame) => {
    const result = mintResult(representation)
    append(block, { kind: 'construct', lineage, callee, newTarget, target, ...(hostFrame ? { hostFrame } : {}), arguments: args, result })
    return result.id
  }

  const constant: IrBodyBuilder['constant'] = (block, lineage, text, literal, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'constant', lineage, text, literal, result })
    return result.id
  }

  const bindingRead: IrBodyBuilder['bindingRead'] = (block, lineage, declaration, representation, reactive) => {
    const result = mintResult(representation)
    append(block, { kind: 'binding-read', lineage, declaration, result, ...(reactive ? { reactive } : {}) })
    return result.id
  }

  const bindingWrite: IrBodyBuilder['bindingWrite'] = (block, lineage, declaration, value) => {
    append(block, { kind: 'binding-write', lineage, declaration, value })
  }

  const parameter: IrBodyBuilder['parameter'] = (block, lineage, ordinal, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'parameter', lineage, ordinal, result })
    return result.id
  }

  const receiver: IrBodyBuilder['receiver'] = (block, lineage, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'receiver', lineage, result })
    return result.id
  }

  const globalThis: IrBodyBuilder['globalThis'] = (block, lineage, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'global-this', lineage, result })
    return result.id
  }

  const unresolvableReference: IrBodyBuilder['unresolvableReference'] = (block, lineage, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'unresolvable-reference', lineage, result })
    return result.id
  }

  const awaitValue: IrBodyBuilder['await'] = (block, lineage, operand, representation) => {
    const result = mintOptionalResult(representation)
    append(block, { kind: 'await', lineage, operand, result })
    return result?.id ?? null
  }

  const yieldValue: IrBodyBuilder['yield'] = (block, lineage, operand, representation) => {
    const result = mintOptionalResult(representation)
    append(block, { kind: 'yield', lineage, operand, result })
    return result?.id ?? null
  }

  const catchBinding: IrBodyBuilder['catchBinding'] = (block, lineage, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'catch-binding', lineage, result })
    return result.id
  }

  const compute: IrBodyBuilder['compute'] = (block, lineage, form, operator, operands, representation) => {
    const result = mintResult(representation)
    const nativeEquality = form === 'equality' || form === 'binary' ? nativeEqualityOf(operator, operands) : null
    append(block, { kind: 'compute', lineage, form, operator, operands, result, ...(nativeEquality ? { nativeEquality } : {}) })
    return result.id
  }

  const phi: IrBodyBuilder['phi'] = (block, lineage, incoming, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'phi', lineage, incoming, result })
    return result.id
  }

  const branch: IrBodyBuilder['branch'] = (block, lineage, condition, whenTrue, whenFalse) => {
    terminate(block, { kind: 'branch', lineage, condition, whenTrue, whenFalse })
  }

  const jump: IrBodyBuilder['jump'] = (block, lineage, target) => {
    terminate(block, { kind: 'jump', lineage, target })
  }

  const returnOp: IrBodyBuilder['return'] = (block, lineage, value) => {
    terminate(block, { kind: 'return', lineage, value })
  }

  const throwOp: IrBodyBuilder['throw'] = (block, lineage, value) => {
    terminate(block, { kind: 'throw', lineage, value })
  }

  const switchOp: IrBodyBuilder['switch'] = (block, lineage, discriminant, cases, defaultTarget) => {
    terminate(block, { kind: 'switch', lineage, discriminant, cases, defaultTarget })
  }

  const allocateOrdinaryObject: IrBodyBuilder['allocateOrdinaryObject'] = (block, lineage, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'allocate-ordinary-object', lineage, result })
    return result.id
  }

  const allocateArrayObject: IrBodyBuilder['allocateArrayObject'] = (block, lineage, elements, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'allocate-array-object', lineage, elements, result })
    return result.id
  }

  const allocateCallable: IrBodyBuilder['allocateCallable'] = (block, lineage, functionId, captures, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'allocate-callable', lineage, functionId, captures, result })
    return result.id
  }

  const bindCallable: IrBodyBuilder['bindCallable'] = (
    block,
    lineage,
    source,
    sourceFunctionId,
    sourceAbi,
    thisArgument,
    receiver,
    bound,
    representation,
    detached = false
  ) => {
    const result = mintResult(representation)
    append(block, { kind: 'bind-callable', lineage, source, sourceFunctionId, sourceAbi, thisArgument, receiver, bound, detached, result })
    return result.id
  }

  const allocateConstructor: IrBodyBuilder['allocateConstructor'] = (block, lineage, declaration, captures, representation, heritage) => {
    const result = mintResult(representation)
    append(block, { kind: 'allocate-constructor', lineage, declaration, captures, ...(heritage ? { heritage } : {}), result })
    return result.id
  }

  const allocateProxy: IrBodyBuilder['allocateProxy'] = (block, lineage, target, handler, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'allocate-proxy', lineage, target, handler, result })
    return result.id
  }

  const allocateRecord: IrBodyBuilder['allocateRecord'] = (block, lineage, fields, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'allocate-record', lineage, fields, result })
    return result.id
  }

  const allocateTemplateObject: IrBodyBuilder['allocateTemplateObject'] = (block, lineage, cooked, raw, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'allocate-template-object', lineage, cooked, raw, result })
    return result.id
  }

  const allocateRegExp: IrBodyBuilder['allocateRegExp'] = (block, lineage, source, flags, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'allocate-regexp', lineage, source, flags, result })
    return result.id
  }

  const element: IrBodyBuilder['element'] = (block, lineage, form, tag, representation, textLeaf) => {
    const result = mintResult(representation)
    append(block, { kind: 'element', lineage, form, tag, textLeaf, result })
    return result.id
  }

  const elementProp: IrBodyBuilder['elementProp'] = (block, lineage, node, key, value) => {
    append(block, { kind: 'element-prop', lineage, node, key, value, result: null })
  }

  const elementChild: IrBodyBuilder['elementChild'] = (block, lineage, node, child, textLeaf) => {
    append(block, { kind: 'element-child', lineage, node, child, textLeaf, result: null })
  }

  const test: IrBodyBuilder['test'] = (block, lineage, value, predicate = 'to-boolean') => {
    const result = mintResult({ kind: 'scalar', domain: 'boolean' })
    append(block, { kind: 'test', lineage, predicate, value, result })
    return result.id
  }

  const convert: IrBodyBuilder['convert'] = (block, lineage, conversionUse, source, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'convert', lineage, conversionUse, source, result })
    return result.id
  }

  const mergeLiveArmRebuild: IrBodyBuilder['mergeLiveArmRebuild'] = (
    block,
    lineage,
    source,
    representation,
    liveArms,
    sourceAbsenceLive,
    conversions
  ) => {
    const result = mintResult(representation)
    const nativeTransport = nativeMergeTransportOf(source.representation, representation, liveArms, sourceAbsenceLive, conversions)
    append(block, {
      kind: 'merge-live-arm-rebuild',
      lineage,
      source,
      result,
      liveArms,
      sourceAbsenceLive,
      ...(nativeTransport ? { nativeTransport } : {})
    })
    return result.id
  }

  const getIterator: IrBodyBuilder['getIterator'] = (block, lineage, protocol, receiver, method, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'get-iterator', lineage, protocol, receiver, method, result })
    return result.id
  }

  const iteratorNext: IrBodyBuilder['iteratorNext'] = (block, lineage, iterator, value, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'iterator-next', lineage, iterator, value, result })
    return result.id
  }

  const iteratorDone: IrBodyBuilder['iteratorDone'] = (block, lineage, iterator, representation) => {
    const result = mintResult(representation)
    append(block, { kind: 'iterator-done', lineage, iterator, result })
    return result.id
  }

  const iteratorClose: IrBodyBuilder['iteratorClose'] = (block, lineage, iterator, representation, onlyIfOpen) => {
    const result = mintOptionalResult(representation)
    append(block, { kind: 'iterator-close', lineage, iterator, result, onlyIfOpen })
    return result?.id ?? null
  }

  const seal: IrBodyBuilder['seal'] = (tryRegions = [], iteratorCloseRegions = []): IrBody => {
    requireOpen()
    if (entry === null) throw new Error(`IR body builder for ${owner} sealed with no blocks`)
    const frozenBlocks = new Map<IrBlockId, IrBlock>()
    for (const block of blocks.values()) {
      const terminator = block.terminator
      if (!terminator) {
        // Which blocks reach it, and what it holds. A bare "sealed without a
        // terminator" names the symptom and nothing that produced it: the
        // block was opened by some control frame that then left it, and
        // finding which one means knowing whether anything jumps here at all
        // (an orphan the frame opened and abandoned) or whether control does
        // arrive and simply never leaves.
        const predecessors = [...blocks.values()]
          .filter((other) => {
            const other_terminator = other.terminator
            if (!other_terminator) return false
            if (other_terminator.kind === 'jump') return other_terminator.target === block.id
            if (other_terminator.kind === 'branch') return other_terminator.whenTrue === block.id || other_terminator.whenFalse === block.id
            return false
          })
          .map((other) => other.id)
        throw new Error(
          `block ${block.id} sealed without a terminator; it holds ${block.operations.length} operation(s) and is reached from ` +
            `${predecessors.length === 0 ? 'nothing (it was opened and abandoned)' : predecessors.join(', ')}`
        )
      }
      frozenBlocks.set(block.id, Object.freeze({ id: block.id, operations: Object.freeze([...block.operations]), terminator }))
    }
    sealed = true
    const body: IrBody = Object.freeze({
      owner,
      sourceOwner,
      abi,
      construct: constructAbi,
      entry,
      blocks: frozenBlocks,
      blockOrder: Object.freeze([...order]),
      values: new Map(values),
      tryRegions: Object.freeze([...tryRegions]),
      iteratorCloseRegions: Object.freeze([...iteratorCloseRegions])
    })
    const violations = verifyIrBody(body)
    if (violations.length > 0) {
      throw new Error(
        `IR body for ${owner} failed verification with ${violations.length} violation(s):\n${violations.map((v) => `  [${v.guard}] ${v.message}`).join('\n')}`
      )
    }
    return body
  }

  return {
    openBlock,
    isTerminated,
    get,
    set,
    delete: deleteProperty,
    hasProperty,
    ownPropertyKeys,
    defineOwnProperty,
    spreadCopy,
    call,
    commonJsRequire,
    commonJsBinding,
    commonJsBindingSet,
    superInitialize,
    reparentConstructor,
    construct,
    constant,
    bindingRead,
    bindingWrite,
    parameter,
    receiver,
    globalThis,
    unresolvableReference,
    await: awaitValue,
    yield: yieldValue,
    catchBinding,
    compute,
    phi,
    branch,
    jump,
    return: returnOp,
    throw: throwOp,
    switch: switchOp,
    allocateOrdinaryObject,
    allocateArrayObject,
    element,
    elementProp,
    elementChild,
    test,
    allocateCallable,
    bindCallable,
    allocateConstructor,
    allocateProxy,
    allocateRecord,
    allocateTemplateObject,
    allocateRegExp,
    convert,
    mergeLiveArmRebuild,
    getIterator,
    iteratorNext,
    iteratorDone,
    iteratorClose,
    blockOrder: () => [...order],
    successorsOfBlock,
    seal
  }
}
