import { objectTagExpression, objectTagCapability } from './emit-object-tag.js'
import type { NativeSelectionHelper } from './native-selection-helpers.js'
import { stableBorrowActualsOf } from '../../ir/borrowed-call-arguments.js'
import { owningConversionInputText } from './owning-conversion-input.js'
import type { StableBorrowEntry } from './borrowed-call-entry.js'
import { boxedValueText } from './emit-dynamic-properties.js'
import { ownedDyingValuesOf, ownedFormalInputsOf, transfersFormalConversion } from '../../ir/transfer.js'
import type { FunctionId, DeclarationId, IrValueId } from '../../identity/ids.js'
import type { BindingPlacement } from '../../projection/bindings.js'
import { constructedBaseOf, type ClassLayout } from '../../projection/classes.js'
import type {
  AwaitOperation,
  ComputeOperation,
  ConstantOperation,
  ConvertOperation,
  IrBlock,
  IrBlockId,
  IrBody,
  IrNonTerminatorOperation,
  IrTerminatorOperation,
  IrIteratorCloseRegion,
  IrTryRegion,
  TestOperation,
  ParameterOperation,
  ReceiverOperation,
  GlobalThisOperation,
  UnresolvableReferenceOperation,
  YieldOperation
} from '../../ir/model.js'
import { allOperationsOf } from '../../ir/model.js'
import { resultOfIrOperation } from '../../ir/queries.js'
import type { CallableAbi, Representation } from '../../representation/model.js'
import { representationKey } from '../../representation/model.js'
import type { RepresentationDeriver } from '../../representation/derive.js'
import type { CppArtifact, CppFacts, CppSectionOwner } from './document.js'
import type { HostSpellings } from './host/host-members.js'
import {
  cppFormalName,
  cppReceiverName,
  createCppEmitBlockedError,
  createEmitContext,
  defineValue,
  defineValueAlias,
  directCalleesOf,
  emptyCaptureIndex,
  isIntegerStorageValue,
  isCppEmitBlockedError,
  operandText,
  storageTypeOf,
  type CaptureIndex,
  type EmitBodyFacts,
  type EmitContext,
  type TemplateObjectDefinition,
  cppThunkName,
  sealFactFieldsForRender
} from './emit-context.js'
import { hostMemberReadsOf } from './host/emit-host-properties.js'
import { hostNamespaceReadsOf } from './host-namespace-reads.js'
import { functionSourceReadsOf } from './function-source-reads.js'
import { prototypeMethodReadsOf } from './prototype/prototype-method-reads.js'
import { directCallReceiversOf, virtualCalleesOf } from './direct-call-receivers.js'
import { unionMemberTypeofReadsOf, unionMethodReadsOf } from './emit-union-properties.js'
import { reactiveOriginsOf } from './reactive-origins.js'
import { renderTryRegion, type RegionRendering } from './emit-exceptions.js'
import { emitReturn } from './emit-return.js'
import {
  collectDirectBindingSinks,
  classObjectReadsOf,
  hostClassReadsOf,
  collectFormalCells,
  earlyCapturedCellPrologue,
  emitBindingRead,
  emitBindingWrite
} from './emit-bindings.js'
import type { ConversionCensus } from '../../conversion/nodes.js'
import { type PrinterDrift, alignedValueText, emitMergeLiveArmRebuild, namedConversionText, widenedStoreText } from './emit-narrowing.js'
import { admitDenseWindows, collectCapacityHints, emitAllocateArrayObject, emitDenseSetup, emitFillLoop } from './emit-arrays.js'
import type { IntegerStorageFacts } from '../../ir/integers.js'
import { noInstantiationFacts, type InstantiationFacts } from '../../ir/instantiation.js'
import { observesEveryCallableIdentity, type CallableIdentityDemand } from '../../ir/callable-identity-demand.js'
import { stringConstantsOf } from '../../ir/dead-values.js'
import type { HoistPlan } from '../../ir/hoist.js'
import { bodyValueOriginsOf, irBodyCensusOf } from '../../ir/facts.js'
import { emitGetIterator, emitIteratorClose, emitIteratorDone, emitIteratorNext, renderIteratorCloseRegion } from './emit-iterator.js'
import { absenceComparisonText, booleanTestText, definedTestText, presenceTestText } from './emit-presence.js'
import { callableIdentityEqualityText, constantStringComparisonText, strictEqualityText } from './emit-equality.js'
import { nativeEqualityText } from './emit-native-equality.js'
import { denseRemainderCompanion, integerBitwiseOperators, integerBoundedComparison, remainderText } from './emit-integers.js'
import { instanceofText } from './emit-instanceof.js'
import {
  typeofTagLiteral,
  typeofTagText,
  typeofText,
  typeofTextFor,
  unionMemberTypeofTagText,
  unionMemberTypeofText
} from './emit-typeof.js'
import { emitHasProperty } from './emit-in.js'
import { mergeWritesOf } from './emit-namespaces.js'
import { templateText, toStringRefusal } from './emit-tostring.js'
import { mixedDynamicPlusText } from './emit-mixed-binary.js'
import { emitFieldStore, emitGet, isPlainMemberRead } from './emit-properties.js'
import { directClassMethodBody } from './class-properties/emit-class-properties.js'
import { classMemberOf, lazyCalleeReadsOf, structNameOfReceiver } from './class-layout.js'
import {
  emitAllocateRecord,
  emitAllocateRegExp,
  emitAllocateTemplateObject,
  emitToNumericCoercion,
  emitSpreadCopy
} from './emit-allocation.js'
import {
  alignedText,
  receiverBoundCallableText,
  emitAllocateCallable,
  emitAllocateConstructor,
  emitBindCallable,
  emitCall,
  emitConstruct,
  emitSuperInitialize
} from './emit-callable.js'
import {
  cppClassName,
  cppCommonJsModuleName,
  cppCommonJsRecordName,
  cppConstantLiteral,
  cppStringLiteral,
  cppTypeOf,
  cppUndefinedValue
} from './types.js'
import { awaitedText } from './prototype/emit-prototype-promise.js'
import { classTableRootsOf, emitElement, emitElementChild, emitElementProp } from './emit-jsx.js'
import { emitDeleteOperation, emitUnaryDelete } from './emit-dynamic-properties.js'
import type { HostMethodAlias } from './host/host-method-aliases.js'

/**
 * The execution region this section belongs to.
 *
 * `IrBody` carries it directly (`sourceOwner`), which is the only honest route:
 * the `PhysicalBodyId` folds an owner and a variant key into one string, and
 * taking that apart here would make this file a second authority over a
 * structure `identity/ids.ts` alone defines -- the same objection that forbids
 * recovering a decision by parsing rendered C++.
 */
const sectionOwnerOf = (body: IrBody): CppSectionOwner => body.sourceOwner

const emitConstant = (ctx: EmitContext, lines: string[], operation: ConstantOperation): void => {
  // Already spelled at every use by `spellConstants`; nothing is left to render.
  if (ctx.deferredTexts.has(operation.result.id)) return
  const name = defineValue(ctx, operation.result)
  ctx.constantTexts.set(operation.result.id, operation.text)
  lines.push(`${name} = ${cppConstantLiteral(operation.text, operation.literal, operation.result.representation)};`)
}

/**
 * Every literal of a body, spelled inline at each of its uses instead of once
 * into a temporary.
 *
 * A literal reads no state and has no operands, so the two conditions the
 * deferral census imposes on everything else -- one use, in the same block --
 * protect nothing here: the text `("cities")` means the same thing wherever
 * it lands, and there is no definition a `goto` could skip. What a temporary
 * cost was real: a string literal used three times was one construction and
 * two copies (three allocations) where three inline spellings are three
 * constructions (three allocations, no worse), and a literal whose uses are
 * all member keys -- spelled `->cities` by the access, never as text -- was
 * a temporary nothing read at all. `examples/apps/weather` carried 142 of
 * those. Recorded before any block renders so a use in an earlier block of
 * `blockOrder` than its definition still finds the text.
 */
const spellConstants = (ctx: EmitContext, body: IrBody): void => {
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      if (operation.kind !== 'constant') continue
      ctx.constantTexts.set(operation.result.id, operation.text)
      ctx.deferredTexts.set(
        operation.result.id,
        `(${cppConstantLiteral(operation.text, operation.literal, operation.result.representation)})`
      )
    }
  }
}

/**
 * How one C++ operator is written: between its operands, or as a call.
 *
 * `%` and `**` have no infix spelling on `double` in C++ -- `%` is integer-only
 * and `**` does not exist -- so they are library calls. Keeping the two shapes
 * apart in the type is what stops `a ** b` from rendering as text C++ rejects.
 */
type CppOperatorSpelling = { readonly kind: 'infix'; readonly text: string } | { readonly kind: 'call'; readonly text: string }

/**
 * The C++ spelling of one language operator on one carrier.
 *
 * Keyed by the carrier as well as the operator, because the same token is a
 * different machine operation on different carriers -- and on several carriers
 * it is not a machine operation at all. `null` means no spelling exists here,
 * which is refused rather than approximated.
 *
 * `%` and `**` have no infix spelling on `double` in C++, so they are library
 * calls (`gea::remainder`/`std::pow`, below) -- and so are `&`/`|`/`^`/`<<`/`>>`/
 * `>>>`, for a different reason: ECMAScript defines every one of them through
 * `ToInt32`/`ToUint32` (ECMA-262 7.1.6/7.1.7) of the operand, never through the
 * IEEE-754 double the plan actually carries. `a & b` truncates and wraps each
 * operand into a 32-bit two's-complement integer first (ECMA-262 6.1.6.1.16-19
 * `NumberBitwiseOp`/`Number::bitwiseAND`/`bitwiseXOR`/`bitwiseOR`; 6.1.6.1.2
 * `bitwiseNOT` for `~`), and the three shifts additionally reduce the shift
 * count with `ToUint32(rhs) modulo 32` (6.1.6.1.9-11 `leftShift`/
 * `signedRightShift`/`unsignedRightShift`) before shifting. A bare C++ `&`/
 * `<<` on `double` would not even compile, and doing the ToInt32/ToUint32
 * conversion inline at each of these six call sites would be six copies of
 * the identical wraparound to keep in step, so `gea::toInt32`/`gea::toUint32`
 * and the `gea::bitwise*`/`*Shift` wrappers built from them live once in
 * `runtime/gea_runtime.h` -- reusing the identical modulo-2**32 wraparound the
 * TypedArray element store already performs there
 * (`detail::typedArrayIntegerModulo`) -- and are called here as
 * `CppOperatorSpelling`s of kind `'call'`, exactly like `gea::remainder`/`std::pow`.
 *
 * Only the `number`/`float64` domain gets a bitwise spelling. `bigint` looks
 * like it belongs in the same table -- ECMAScript spells the identical six
 * tokens over it -- but it is a genuinely different operation: arbitrary-
 * precision two's complement, no `ToInt32` anywhere in the algorithm
 * (ECMA-262 6.1.6.2.2/.9/.18-19 `BigInt::bitwiseNOT`/`leftShift`/`bitwiseAND`/
 * `bitwiseOR`), and `ApplyStringOrNumericBinaryOperator` (13.15.3) step 5
 * throws a `TypeError` rather than ever converting a `BigInt` through the
 * `Number` path. So it stays refused here by the same `null` this table
 * already returns for every other unimplemented `bigint` operator, not routed
 * through `ToInt32` as an approximation -- which would silently truncate any
 * BigInt outside the 32-bit range. `int32`/`uint32` are listed in
 * `ScalarDomain` but `representation/derive.ts` never actually selects either
 * for an ordinary value -- every plain `number` reaches this table as domain
 * `'number'` -- so there is, today, no carrier for which the round trip could
 * be skipped; see `.scratch/port/bitwise/citations.md` section 5.
 *
 * `===` maps to `==` and `!==` to `!=`: on a single, non-dynamic carrier the
 * strict comparison has no type check left to perform, because both sides were
 * already proven to hold the same carrier before this is reached.
 *
 * `==` and `!=` map to the same spellings, and for the same reason -- not as a
 * shortcut, but because that identical-carrier proof is precisely the premise
 * ECMA-262 7.2.15 (IsLooselyEqual) tests first: "If Type(x) is Type(y), return
 * IsStrictlyEqual(x, y)". Loose equality only diverges from strict when it has
 * a type difference to coerce across, and `emitBinary` refuses a mixed-carrier
 * operator by name immediately above this lookup, so no such pair can reach a
 * table. The one other divergence -- `x == null` matching both `null` and
 * `undefined` -- never reaches here either: `absenceComparisonText` settles a
 * comparison against an absent value earlier, and distinguishes the loose form
 * from the strict one itself (`emit-presence.ts`). What is left is the case the
 * spec collapses, so collapsing it here is the language's own answer rather
 * than this emitter's approximation of it.
 */
const numericBinaryOperators: ReadonlyMap<string, CppOperatorSpelling> = new Map([
  ['+', { kind: 'infix', text: '+' }],
  ['-', { kind: 'infix', text: '-' }],
  ['*', { kind: 'infix', text: '*' }],
  ['/', { kind: 'infix', text: '/' }],
  ['%', { kind: 'call', text: 'gea::remainder' }],
  ['**', { kind: 'call', text: 'std::pow' }],
  ['<', { kind: 'infix', text: '<' }],
  ['>', { kind: 'infix', text: '>' }],
  ['<=', { kind: 'infix', text: '<=' }],
  ['>=', { kind: 'infix', text: '>=' }],
  ['===', { kind: 'infix', text: '==' }],
  ['!==', { kind: 'infix', text: '!=' }],
  ['==', { kind: 'infix', text: '==' }],
  ['!=', { kind: 'infix', text: '!=' }],
  // ECMA-262 6.1.6.1.16-19: both operands go through ToInt32 (7.1.6), the 32-bit
  // two's-complement bits combine, and the result widens back to Number as signed.
  ['&', { kind: 'call', text: 'gea::bitwiseAnd' }],
  ['|', { kind: 'call', text: 'gea::bitwiseOr' }],
  ['^', { kind: 'call', text: 'gea::bitwiseXor' }],
  // ECMA-262 6.1.6.1.9-11: the shift count is ToUint32(rhs) (7.1.7) modulo 32;
  // `<<`/`>>` keep the left signed (ToInt32), `>>>` makes it unsigned (ToUint32)
  // -- the one place these diverge from AND/OR/XOR, so each gets its own wrapper.
  ['<<', { kind: 'call', text: 'gea::leftShift' }],
  ['>>', { kind: 'call', text: 'gea::signedRightShift' }],
  ['>>>', { kind: 'call', text: 'gea::unsignedRightShift' }]
])

/** The relational operators `mixedRelationalText` answers -- IsLessThan's own four spellings, never `===`/`==` (a different rule, `emit-equality.ts`). */
const relationalOperators = new Set(['<', '>', '<=', '>='])

const stringBinaryOperators: ReadonlyMap<string, CppOperatorSpelling> = new Map([
  ['+', { kind: 'infix', text: '+' }],
  ['<', { kind: 'infix', text: '<' }],
  ['>', { kind: 'infix', text: '>' }],
  ['<=', { kind: 'infix', text: '<=' }],
  ['>=', { kind: 'infix', text: '>=' }],
  ['===', { kind: 'infix', text: '==' }],
  ['!==', { kind: 'infix', text: '!=' }],
  ['==', { kind: 'infix', text: '==' }],
  ['!=', { kind: 'infix', text: '!=' }]
])

/**
 * Symbols compare and do nothing else.
 *
 * `<`/`>`/`+` on a symbol are TypeErrors in the language, so they have no
 * spelling here rather than a wrong one. `==` is listed beside `===` because
 * this table is only ever reached with BOTH sides already carrying `symbol`
 * (`emitCompute` refuses a mixed-carrier operator above it), and for two
 * symbols the loose and strict comparisons are the same operation.
 */
const symbolBinaryOperators: ReadonlyMap<string, CppOperatorSpelling> = new Map([
  ['===', { kind: 'infix', text: '==' }],
  ['!==', { kind: 'infix', text: '!=' }],
  ['==', { kind: 'infix', text: '==' }],
  ['!=', { kind: 'infix', text: '!=' }]
])

/**
 * `||` is here and `logical` is not the form that reaches it.
 *
 * A source `a || b` is a `logical` computation -- ECMA-262 13.13.1 evaluates
 * the right operand only when the left is falsy -- and `ir/lower.ts` lowers
 * that one through a merge of two arms, never through this table. What arrives
 * here as a `binary` `||` is a disjunction whose operands are both already
 * evaluated values, which is what `producers/control.ts` mints to give a group
 * of `case` clauses one guard. Rendering it `a || b` is exact: C++ would
 * short-circuit a computation that has already happened.
 */
const booleanBinaryOperators: ReadonlyMap<string, CppOperatorSpelling> = new Map([
  ['===', { kind: 'infix', text: '==' }],
  ['!==', { kind: 'infix', text: '!=' }],
  ['==', { kind: 'infix', text: '==' }],
  ['!=', { kind: 'infix', text: '!=' }],
  ['||', { kind: 'infix', text: '||' }]
])

/**
 * ECMAScript OBJECT IDENTITY, for the two carriers that are exactly a pointer.
 *
 * `IsStrictlyEqual` on two objects (ECMA-262 7.2.16, via SameValueNonNumber
 * 7.2.12) is "the same object reference", and both of these carriers are a
 * `std::shared_ptr` to an object nothing copies behind the program's back --
 * so `==` on the pointers answers precisely that question, with no conversion
 * invented. `view.buffer === buffer` is the idiom this exists for: it is how a
 * program asks whether two views alias the same block, and the only way to ask
 * it that does not involve writing through one view and reading another.
 *
 * It is deliberately NOT generalized to every reference-shaped carrier.
 * `borrowed-ref` and `native-record-ref` are views this compiler mints rather
 * than objects the program created, and a `record` may be carried by value --
 * pointer identity on any of those would answer a different question than the
 * language asks, so they keep refusing by name.
 */
const referenceIdentityOperators: ReadonlyMap<string, CppOperatorSpelling> = new Map([
  ['===', { kind: 'infix', text: '==' }],
  ['!==', { kind: 'infix', text: '!=' }],
  ['==', { kind: 'infix', text: '==' }],
  ['!=', { kind: 'infix', text: '!=' }]
])

const binaryOperatorFor = (operator: string, carrier: Representation): CppOperatorSpelling | null => {
  if (carrier.kind === 'string') return stringBinaryOperators.get(operator) ?? null
  // `CallableObject` stores the ECMAScript function allocation's stable
  // identity, and its `operator==` compares exactly that identity. Copies and
  // ABI adapters preserve it, while separately evaluated capture-free arrows
  // receive distinct identities. The carrier therefore owns the same strict
  // and loose same-type equality rule as Symbol and the pointer-backed object
  // carriers below.
  if (carrier.kind === 'function-value-dispatch') return referenceIdentityOperators.get(operator) ?? null
  // The identity carrier IS that stable identity, reached through the same
  // handle -- so equality on it is the very comparison the paragraph above
  // describes, with the convention stripped away.
  if (carrier.kind === 'callable-identity') return referenceIdentityOperators.get(operator) ?? null
  // Two references to one generic source function are one function object,
  // and the set's tag IS which function: equal tags, same function.
  if (carrier.kind === 'generic-function-set') return referenceIdentityOperators.get(operator) ?? null
  // A native handle with no host-stated carrier is `gea::NativeHandle<Tag>`,
  // whose whole content is the `int id_` indexing the native store -- so two
  // handles name the same host object exactly when their ids agree, and `==`
  // over that id is the entirety of SameValueNonNumeric for the carrier. This
  // is what answers `const m = Math; m === Math` for a namespace-shaped
  // protocol, where the handle has exactly one inhabitant.
  //
  // A protocol whose plugin DID state a carrier is spelled as that host type
  // instead (`cppTypeOf`'s `representation.native ?? ...`), and this emitter
  // has been told nothing about its equality -- so it keeps refusing rather
  // than emitting a comparison whose meaning belongs to the host.
  if (carrier.kind === 'native-handle') return carrier.native === null ? (referenceIdentityOperators.get(operator) ?? null) : null
  if (
    carrier.kind === 'array-buffer' ||
    carrier.kind === 'shared-array-buffer' ||
    carrier.kind === 'data-view' ||
    (carrier.kind === 'typed-array' && carrier.ownership === 'shared-refcount')
  )
    return referenceIdentityOperators.get(operator) ?? null
  if (carrier.kind === 'symbol') return symbolBinaryOperators.get(operator) ?? null
  if (carrier.kind !== 'scalar') return null
  if (carrier.domain === 'boolean') return booleanBinaryOperators.get(operator) ?? null
  if (carrier.domain === 'bigint') {
    if (operator === '**') return { kind: 'call', text: 'gea::BigInt::pow' }
    if (operator === '>>>') return null
    const spelling = numericBinaryOperators.get(operator)
    return spelling ? { kind: 'infix', text: ['%', '&', '|', '^', '<<', '>>'].includes(operator) ? operator : spelling.text } : null
  }
  if (carrier.domain === 'number' || carrier.domain === 'float64') return numericBinaryOperators.get(operator) ?? null
  // int32/uint32/bigint have exact range semantics that a bare C++ operator does
  // not reproduce (wrapping, promotion, arbitrary precision); no spelling here.
  return null
}

const updateStepOperators: ReadonlyMap<string, string> = new Map([
  ['++', '+'],
  ['--', '-']
])

const numericUnaryOperators: ReadonlyMap<string, CppOperatorSpelling> = new Map([
  ['-', { kind: 'infix', text: '-' }],
  ['+', { kind: 'infix', text: '+' }],
  // ECMA-262 6.1.6.1.2 Number::bitwiseNOT: ToInt32(x) (7.1.6), bitwise
  // complement, widened back to Number as signed -- the same round trip
  // `gea::bitwiseAnd`/... perform, so it goes through the identical helper.
  ['~', { kind: 'call', text: 'gea::bitwiseNot' }]
])

const unaryOperatorFor = (operator: string, carrier: Representation): CppOperatorSpelling | null => {
  if (carrier.kind === 'scalar' && carrier.domain === 'bigint')
    return operator === '-' || operator === '~' ? { kind: 'infix', text: operator } : null
  if (carrier.kind === 'scalar' && carrier.domain === 'boolean') return operator === '!' ? { kind: 'infix', text: '!' } : null
  if (carrier.kind === 'scalar' && (carrier.domain === 'number' || carrier.domain === 'float64')) {
    return numericUnaryOperators.get(operator) ?? null
  }
  return null
}

const emitCompute = (ctx: EmitContext, lines: string[], operation: ComputeOperation): void => {
  // `ctx.computeOrigins` already names this operation for this result --
  // settled in `EmitBodyFacts` before any spelling is chosen, so
  // `emit-bindings.ts` can recognize a cell's own compound update regardless
  // of which of the returns below spells this same operation.
  const queryComparison = ctx.typeQueryComparisons.get(operation)
  if (queryComparison) {
    const left =
      queryComparison.left.kind === 'tag' ? operandText(ctx, queryComparison.left.operand) : typeofTagLiteral(queryComparison.left.text)
    const right =
      queryComparison.right.kind === 'tag' ? operandText(ctx, queryComparison.right.operand) : typeofTagLiteral(queryComparison.right.text)
    const answer =
      left === null || right === null ? String(queryComparison.unequal) : `${left} ${queryComparison.unequal ? '!=' : '=='} ${right}`
    lines.push(`${defineValue(ctx, operation.result)} = ${answer};`)
    return
  }
  const operands = operation.operands
  if (operation.nativeEquality) {
    const left = operands[0]
    const right = operands[1]
    if (!left || !right)
      throw createCppEmitBlockedError('runtime-helper:computation:binary:arity', 'a native equality recipe requires two operands')
    const answer = nativeEqualityText(operation.nativeEquality, [operandText(ctx, left), operandText(ctx, right)])
    lines.push(`${defineValue(ctx, operation.result)} = ${answer};`)
    return
  }
  // `void x` evaluates its operand and yields `undefined` (ECMA-262 13.5.2).
  // Nothing about that answer depends on what the operand carried, so it is
  // settled before any carrier lookup -- like `!` below, and unlike `-`/`+`,
  // which run ToNumber and so must consult one. The operand's own evaluation
  // is already its own operation in this graph, so discarding its value here
  // is the whole of the semantics -- which is also why this is the one form
  // that legitimately arrives with NO operand at all: `void f()` for an `f`
  // that returns nothing has no SSA name to cite, and the lowering cites none
  // rather than inventing one (`ir/lower.ts`).
  if (operation.form === 'unary' && operation.operator === 'void') {
    const produced = operation.result.representation
    if (produced.kind !== 'undefined') {
      throw createCppEmitBlockedError(
        `physical-cpp-type:${representationKey(produced)}`,
        `unary "void" published a "${produced.kind}" carrier, but the language gives the expression undefined`
      )
    }
    lines.push(`${defineValue(ctx, operation.result)} = ${cppUndefinedValue};`)
    return
  }
  const first = operands[0]
  if (!first)
    throw createCppEmitBlockedError('runtime-helper:computation:no-operands', 'a computation with no operands has no C++ spelling')

  if (operation.form === 'require-object-coercible') {
    const text = operandText(ctx, first)
    lines.push(`if (!(${presenceTestText(text, first.representation)})) gea::host::throwGetPropertyOfNullish<void>();`)
    defineValueAlias(ctx, operation.result, text)
    return
  }

  // The presence half of an array pattern's own possibly-absent source
  // (`ir/lower-destructuring.ts`'s `lowerArrayPatternSource`): the identical
  // `gea::detail::requireIterablePresent` the general `for`-`of` protocol's
  // own absent sources already call in front of their cursor constructor
  // (`emit-iterator.ts`), reused here in front of the array-pattern fast
  // path's positional reads instead.
  if (operation.form === 'require-iterable-present') {
    const text = operandText(ctx, first)
    const name = defineValue(ctx, operation.result)
    lines.push(`${name} = gea::detail::requireIterablePresent(${text}, ${cppStringLiteral('a nested array-destructuring position')});`)
    return
  }

  // The arm half of the same source, once unwrapped: `soleArrayPatternCapableArm`
  // (`representation/model.ts`) proved exactly one arm of this tagged union
  // supports the pattern's positional reads at compile time, but which VALUE
  // this program actually holds at runtime is still an open question -- the
  // other arm is a real value ECMA-262 7.4.2's `GetIterator` would throw a
  // `TypeError` over, and this is that throw. The arm index was carried
  // through the `operator` field as a decimal string (see `ir/model.ts`'s
  // own doc for why) rather than a real language operator, since `.is<N>()`/
  // `.get<N>()` need it as a compile-time template argument.
  if (operation.form === 'require-tagged-union-arm') {
    const text = operandText(ctx, first)
    const index = operation.operator
    const name = defineValue(ctx, operation.result)
    lines.push(
      `if (!(${text}).is<${index}>()) gea::detail::refuseTaggedUnionArmMismatch(${cppStringLiteral('a nested array-destructuring position')});`
    )
    lines.push(`${name} = (${text}).get<${index}>();`)
    return
  }

  if (operation.form === 'unary') {
    if (operation.operator === 'ObjectTag') {
      const answer = objectTagExpression(first.representation, operandText(ctx, first), ctx)
      if (answer === null)
        throw createCppEmitBlockedError(
          `runtime-helper:${objectTagCapability(first.representation)}`,
          'Object.prototype.toString has no native tag algorithm for this carrier'
        )
      lines.push(`${defineValue(ctx, operation.result)} = ${answer};`)
      return
    }
    // `!x` is `ToBoolean(x)` negated, over whatever carrier `x` arrived in --
    // the same abstract operation a conditional's guard runs, so it is spelled
    // by the same authority rather than by a second rule that could disagree
    // with it. Only `!` is a coercion this way: `-x`/`+x` run ToNumber, which
    // is a different table and stays on the operator map below.
    if (operation.operator === '!') {
      const name = defineValue(ctx, operation.result)
      lines.push(`${name} = !${booleanTestText(operandText(ctx, first), first.representation, isIntegerStorageValue(ctx, first.value))};`)
      return
    }
    // `delete o.p`'s value is the boolean its own `[[Delete]]` published.
    if (operation.operator === 'delete') {
      emitUnaryDelete(ctx, lines, defineValue(ctx, operation.result), first)
      return
    }
    if (operation.operator === 'ToNumeric') return emitToNumericCoercion(ctx, lines, first, operation.result)
    const spelling = unaryOperatorFor(operation.operator, first.representation)
    if (!spelling) {
      throw createCppEmitBlockedError(
        `runtime-helper:computation:unary:${operation.operator}:${first.representation.kind}`,
        `unary "${operation.operator}" on a "${first.representation.kind}" carrier has no C++ spelling in this emitter`
      )
    }
    const name = defineValue(ctx, operation.result)
    const operandRendered = operandText(ctx, first)
    const narrowedNot = operation.operator === '~' && ctx.integerValues.has(first.value)
    const call = narrowedNot ? `gea::integerBitwiseNot(${operandRendered})` : `${spelling.text}(${operandRendered})`
    // C++ integer zero has no negative representation: `-(0)` is still the
    // integer `0`, and converting it to double afterward loses JavaScript's
    // observable -0 (`Object.is`, reciprocal sign, BSON number width). Give a
    // constant zero a floating spelling before negation; every nonzero unary
    // operation keeps the ordinary carrier-directed spelling.
    const constantText = ctx.constantTexts.get(first.value)
    const negativeZero =
      operation.operator === '-' &&
      first.representation.kind === 'scalar' &&
      (first.representation.domain === 'number' || first.representation.domain === 'float64') &&
      constantText !== undefined &&
      Number(constantText) === 0
    const expression = negativeZero ? '-0.0' : spelling.kind === 'infix' ? `${spelling.text}${operandRendered}` : call
    lines.push(`${name} = ${expression};`)
    return
  }

  // `typeof` is a question about the carrier, and for every carrier but a sum
  // the answer is settled before the program runs. `emit-typeof.ts` owns both
  // the mapping and the refusal.
  if (operation.form === 'typeof') {
    // A member read off a union whose arms disagree about the member: the
    // answer is per-arm and the read itself rendered nothing, so the
    // discriminant answers here. See `EmitContext.unionMemberTypeofReads`.
    const memberRead = ctx.unionMemberTypeofReads.get(first.value)
    if (memberRead !== undefined) {
      const receiver = operandText(ctx, memberRead.receiver)
      const answer = ctx.typeQueryValues.has(operation.result.id)
        ? unionMemberTypeofTagText(memberRead.answers, receiver, memberRead.member)
        : unionMemberTypeofText(memberRead.answers, receiver, memberRead.member)
      lines.push(`${defineValue(ctx, operation.result)} = ${answer};`)
      return
    }
    const namespacePath = ctx.hostNamespaceReads.get(first.value) ?? ctx.hostNamespaceValues.get(first.value)
    const namespaceTypeof = namespacePath === undefined ? undefined : ctx.hosts.namespaces.typeofs.get(namespacePath)
    if (ctx.typeQueryValues.has(operation.result.id)) {
      const tag =
        namespaceTypeof === undefined
          ? typeofTagText(first.representation, () => operandText(ctx, first))
          : typeofTagLiteral(namespaceTypeof)
      if (tag === null)
        throw createCppEmitBlockedError(
          `runtime-helper:computation:typeof:${representationKey(first.representation)}`,
          `host typeof published an unknown result ${namespaceTypeof}`
        )
      lines.push(`${defineValue(ctx, operation.result)} = ${tag};`)
      return
    }
    if (namespaceTypeof !== undefined) {
      ctx.constantTexts.set(operation.result.id, namespaceTypeof)
      lines.push(
        `${defineValue(ctx, operation.result)} = ${cppConstantLiteral(namespaceTypeof, 'string', operation.result.representation)};`
      )
      return
    }
    // A settled answer is a string CONSTANT, and saying so is what lets every
    // later rule that reasons about constants see it -- the comparison fold
    // above included. Without this the two halves of `typeof x !== 'undefined'`
    // were a folded literal and a recorded constant, so the fold did not fire
    // and the pair reached C++ as `("object") != ("undefined")`: two literal
    // ADDRESSES. Only recorded when the answer really is static; a sum answers
    // at runtime and is no constant.
    const settled = typeofTextFor(first.representation)
    if (settled !== null) ctx.constantTexts.set(operation.result.id, settled)
    lines.push(`${defineValue(ctx, operation.result)} = ${typeofText(first.representation, () => operandText(ctx, first))};`)
    return
  }

  // `instanceof` is `[[HasInstance]]`, which this backend answers only for the
  // error constructors -- see `emit-instanceof.ts` for why the general case is
  // refused rather than approximated.
  if (operation.form === 'instanceof') {
    const constructor = operands[1]
    if (!constructor || operands.length !== 2) {
      throw createCppEmitBlockedError(
        'runtime-helper:computation:instanceof:arity',
        `an "instanceof" with ${operands.length} operand(s) has no C++ spelling`
      )
    }
    lines.push(`${defineValue(ctx, operation.result)} = ${instanceofText(ctx, first, constructor, operation.classInstanceTest)};`)
    return
  }

  // A template is a concatenation of its pieces, each through ToString.
  if (operation.form === 'template') {
    const rendered = templateText(ctx, operation)
    if ('refused' in rendered)
      throw createCppEmitBlockedError('runtime-helper:computation:template', toStringRefusal(rendered.refused, ctx.classes, ctx.deriver))
    lines.push(`${defineValue(ctx, operation.result)} = ${rendered.text};`)
    return
  }

  // `x++` is `x + 1` over the value ToNumeric already produced, and `x--` is
  // `x - 1`. The store is a separate operation; this instruction only computes
  // the number that gets stored, so it never appears as a C++ `++`.
  if (operation.form === 'update') {
    const step = updateStepOperators.get(operation.operator)
    if (!step || !binaryOperatorFor(step, first.representation)) {
      throw createCppEmitBlockedError(
        `runtime-helper:computation:update:${operation.operator}:${first.representation.kind}`,
        `update "${operation.operator}" on a "${first.representation.kind}" carrier has no C++ spelling in this emitter`
      )
    }
    const name = defineValue(ctx, operation.result),
      raw = `${operandText(ctx, first)} ${step} 1`
    lines.push(`${name} = ${widenedStoreText(operation.result.representation, first.representation, raw) ?? raw};`)
    return
  }

  const second = operands[1]
  if (!second || operands.length !== 2) {
    throw createCppEmitBlockedError(
      'runtime-helper:computation:binary:arity',
      `a binary computation with ${operands.length} operand(s) has no C++ spelling`
    )
  }
  // Equality against `null`/`undefined` is settled by the carriers, not by a
  // conversion between them, so it is answered before the mixed-carrier refusal
  // below -- which would otherwise reject the language's most common absence
  // check as a coercion with no recipe.
  // Native host singleton/class handles are compile-time identity tags. Do
  // not ask them for a runtime value before answering identity: authenticated
  // `process === globalThis.process` has two routes to the same Process
  // protocol and neither route needs to box or materialize that singleton.
  const firstHostIdentity = ctx.hostClassReads.get(first.value)
  const secondHostIdentity = ctx.hostClassReads.get(second.value)
  if (firstHostIdentity && secondHostIdentity && referenceIdentityOperators.has(operation.operator)) {
    const equal = firstHostIdentity.declaration === secondHostIdentity.declaration
    const negated = operation.operator === '!==' || operation.operator === '!='
    const answer = equal !== negated ? 'true' : 'false'
    lines.push(`${defineValue(ctx, operation.result)} = ${answer};`)
    return
  }
  const sides = [first, second].map((operand) => ({ text: operandText(ctx, operand), representation: operand.representation }))
  const absent = sides[0] && sides[1] ? absenceComparisonText(operation.operator, sides[0], sides[1]) : null
  if (absent !== null) {
    lines.push(`${defineValue(ctx, operation.result)} = ${absent};`)
    return
  }
  // Function equality is allocation identity even when the two statically
  // visible call signatures differ. The rule itself is
  // `callableIdentityEqualityText`, asked here and from inside
  // `strictEqualityText`'s own recursion so that a callable wrapped in an
  // OPTIONAL gets the identical answer -- it used to live inline here, where
  // that recursion could not reach it. `Alias === Routed` in
  // `dynamic-callable-abi-recovery.runtime.js` is the bare pair;
  // `stateStack[stackIndex] !== State.done` in `generic-state-function-array.ts`
  // is the wrapped one.
  const callableIdentity = sides[0] && sides[1] ? callableIdentityEqualityText(operation.operator, sides[0], sides[1]) : null
  if (callableIdentity !== null) {
    lines.push(`${defineValue(ctx, operation.result)} = ${callableIdentity};`)
    return
  }
  // A sum on either side is a discriminant test plus one arm's comparison,
  // which the generic path below cannot reach: two different carriers hit its
  // mixed-carrier refusal, and two identical sums hit `binaryOperatorFor`,
  // which has no `==` for a byte buffer. Answered here, before both.
  const equality = sides[0] && sides[1] ? strictEqualityText(operation.operator, sides[0], sides[1]) : null
  if (equality !== null) {
    lines.push(`${defineValue(ctx, operation.result)} = ${equality};`)
    return
  }
  // Two string constants compared: answered in the source language rather than
  // by a C++ operator, which would compare the two literals' ADDRESSES. See
  // `constantStringComparisonText`. Before the `+` fold below because `+` on
  // two strings is concatenation, which that fold already owns.
  if (first.representation.kind === 'string' && second.representation.kind === 'string') {
    const leftConstant = ctx.constantTexts.get(first.value)
    const rightConstant = ctx.constantTexts.get(second.value)
    if (leftConstant !== undefined && rightConstant !== undefined) {
      const folded = constantStringComparisonText(operation.operator, leftConstant, rightConstant)
      if (folded !== null) {
        lines.push(`${defineValue(ctx, operation.result)} = ${folded};`)
        return
      }
    }
  }
  // `+` is string concatenation whenever either operand is a string, and the
  // plan has already settled which `+` this is: the result carrier. Both sides
  // then go through ToString, folded by the same authority a template
  // expression uses -- `'n: ' + count` and `` `n: ${count}` `` are the same
  // value, and spelling them by two rules that could disagree is how one of
  // them ends up wrong. A carrier with no ToString refuses by name here exactly
  // as it does in a template, rather than being boxed.
  if (operation.operator === '+' && operation.result.representation.kind === 'string') {
    const rendered = templateText(ctx, operation)
    if ('refused' in rendered)
      throw createCppEmitBlockedError('runtime-helper:computation:template', toStringRefusal(rendered.refused, ctx.classes, ctx.deriver))
    lines.push(`${defineValue(ctx, operation.result)} = ${rendered.text};`)
    return
  }
  // Exactly one side already `dynamic` and the other an ordinary typed
  // carrier -- `parsed + 1`, `1 + parsed` where `parsed` came from
  // `JSON.parse` or a declared `any` never narrowed -- is answered without
  // boxing the typed side (`mixedDynamicPlusText`'s own comment says why),
  // and UNCONDITIONALLY: a `dynamic` carrier this ordinary is not the opt-in
  // `ctx.deriver.dynamicFallback` feature (that flag gates a different,
  // riskier fallback below), and gating this recipe behind it left the most
  // common dynamic-boundary program -- `JSON.parse(...) + 1` -- refusing by
  // name with exactly this file's own "mixes a dynamic and a scalar carrier"
  // message whenever the flag was off, which is the ordinary case.
  if (operation.operator === '+') {
    const firstDynamic = first.representation.kind === 'dynamic'
    const secondDynamic = second.representation.kind === 'dynamic'
    if (firstDynamic !== secondDynamic) {
      const dynamicOperand = firstDynamic ? sides[0] : sides[1]
      const typedOperand = firstDynamic ? sides[1] : sides[0]
      const native =
        dynamicOperand && typedOperand ? mixedDynamicPlusText(dynamicOperand, typedOperand, firstDynamic, ctx.classes, ctx.deriver) : null
      if (native !== null) {
        const dynamicResult: Representation = { kind: 'dynamic', reason: 'opt-in-fallback' }
        const text = alignedValueText(ctx, 'emit.ts:711', dynamicResult, operation.result.representation, native)
        if (text === null)
          throw createCppEmitBlockedError(
            `conversion:dynamic->${representationKey(operation.result.representation)}`,
            'dynamic addition result has no checked conversion'
          )
        lines.push(`${defineValue(ctx, operation.result)} = ${text};`)
        return
      }
    }
  }
  // Two dynamic sides, or a `tagged-union` on either side, still need
  // `gea::dynamicAdd`'s full ToPrimitive dispatch -- a tagged union's live
  // arm is exactly as unknown at compile time as a dynamic operand's tag, and
  // two genuinely dynamic operands may each be a real JS object whose own
  // `valueOf`/`toString` only `gea::dynamicAdd` runs. This IS the boxing this
  // file's header describes as correct to keep, and stays behind the opt-in
  // flag: it is the one case left that boxes an operand this backend could
  // otherwise have kept native (the `firstDynamic !== secondDynamic` branch
  // just above, when it applies).
  if (
    ctx.deriver.dynamicFallback &&
    operation.operator === '+' &&
    (first.representation.kind === 'dynamic' ||
      second.representation.kind === 'dynamic' ||
      first.representation.kind === 'tagged-union' ||
      second.representation.kind === 'tagged-union')
  ) {
    const left = boxedValueText(ctx, first, 'dynamic addition')
    const right = boxedValueText(ctx, second, 'dynamic addition')
    const dynamic: Representation = { kind: 'dynamic', reason: 'opt-in-fallback' }
    const text = alignedValueText(ctx, 'emit.ts:738', dynamic, operation.result.representation, `gea::dynamicAdd(${left}, ${right})`)
    if (text === null)
      throw createCppEmitBlockedError(
        `conversion:dynamic->${representationKey(operation.result.representation)}`,
        'dynamic addition result has no checked conversion'
      )
    lines.push(`${defineValue(ctx, operation.result)} = ${text};`)
    return
  }
  // A function compared against a function IDENTITY. Not a coercion this file
  // invents: the identity IS what `CallableObject::operator==` compares, so
  // converting the callable side to its own identity handle (the very field
  // that comparison reads) and comparing the two handles is the same answer
  // written one step earlier. Restricted to the four same-type equality
  // operators, which is all `referenceIdentityOperators` spells.
  const identitySpelling = referenceIdentityOperators.get(operation.operator)
  const identitySide = first.representation.kind === 'callable-identity' ? 0 : second.representation.kind === 'callable-identity' ? 1 : null
  if (identitySpelling && identitySide !== null) {
    const callable = identitySide === 0 ? second : first
    const identityCarrier: Representation = { kind: 'callable-identity' }
    const converted = alignedValueText(ctx, 'emit.ts:764', callable.representation, identityCarrier, operandText(ctx, callable))
    if (converted !== null) {
      const held = operandText(ctx, identitySide === 0 ? first : second)
      const [left, right] = identitySide === 0 ? [held, converted] : [converted, held]
      lines.push(`${defineValue(ctx, operation.result)} = ${left} ${identitySpelling.text} ${right};`)
      return
    }
  }
  // Two carriers reaching an operator is not a decision this printer makes
  // any more: ECMA-262's ToNumeric/ToPrimitive before a binary operator is a
  // conversion, and the slot census states it (`projection/slots.ts`'s
  // `binarySlot`) -- lowering coerces both operands into one carrier, or the
  // coercion node is `never` and the operands arrive as they were. What is
  // left here is exactly that `never`: BigInt mixed with Number, a Date's
  // `valueOf`-first ToPrimitive, an object whose own `toString` would have
  // to be called. Refused by name, never spelled by a second table.
  if (representationKey(first.representation) !== representationKey(second.representation)) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(first.representation)}->${representationKey(second.representation)}`,
      `binary "${operation.operator}" mixes a "${first.representation.kind}" and a "${second.representation.kind}" carrier, ` +
        'and the census names no coercion that brings them together'
    )
  }
  const spelling = binaryOperatorFor(operation.operator, first.representation)
  if (!spelling) {
    throw createCppEmitBlockedError(
      `runtime-helper:computation:binary:${operation.operator}:${first.representation.kind}`,
      `binary "${operation.operator}" on a "${first.representation.kind}" carrier has no C++ spelling in this emitter`
    )
  }
  const name = defineValue(ctx, operation.result)
  const integral = ctx.integerValues.has(first.value) && ctx.integerValues.has(second.value)
  // `/` is the one arithmetic operator whose C++ meaning CHANGES when both
  // operands are integers: `7 / 2` would become 3 rather than 3.5, so two
  // narrowed operands are widened back for it. `%` goes the other way -- C++
  // truncates toward zero just as ECMA-262 6.1.6.1.6 does, so an integer
  // remainder is the same answer without the fmod round trip, under its own
  // name rather than an overload (a mixed call would make a pair ambiguous).
  const widenForDivision = integral && operation.operator === '/'
  const left = widenForDivision ? `static_cast<double>(${operandText(ctx, first)})` : operandText(ctx, first)
  const right = widenForDivision ? `static_cast<double>(${operandText(ctx, second)})` : operandText(ctx, second)
  const bounded = integerBoundedComparison(ctx.integerValues, ctx.loopInvariantValues, operation, first, second, left, right)
  if (bounded !== null) {
    lines.push(`${name} = ${bounded};`)
    return
  }
  // The cheaper spellings of `%`, chosen by the integer census (`ir/integers.ts`)
  // and written out by `emit-integers.ts`; `null` keeps `gea::remainder`.
  const form = integral && ctx.integerValues.has(operation.result.id) ? 'narrowed' : ctx.remainderForms.get(operation.result.id)
  const hoisted = operation.operator === '%' ? ctx.denseLengths.get(second.value) : undefined
  const remainder = operation.operator !== '%' ? null : remainderText(form, left, right, ctx.declarations, hoisted)
  if (remainder !== null) {
    // A wrapped window's subscript is computed in the INTEGERS (`denseRemainderCompanion`).
    const window = hoisted === undefined || !ctx.integerValues.has(first.value) ? undefined : hoisted
    const dense = window === undefined ? null : denseRemainderCompanion(window, left, ctx.declarations, lines)
    if (dense !== null) ctx.denseIndices.set(operation.result.id, dense.index)
    lines.push(`${name} = ${dense === null ? remainder : dense.value};`)
    return
  }
  const integerBitwise = integral ? integerBitwiseOperators.get(operation.operator) : undefined
  if (integerBitwise !== undefined) {
    lines.push(`${name} = ${integerBitwise}(${left}, ${right});`)
    return
  }
  const expression = spelling.kind === 'infix' ? `${left} ${spelling.text} ${right}` : `${spelling.text}(${left}, ${right})`
  // Coerced operands compute the operator's own result -- a Number, a String
  // for `+` over strings, a Boolean for a relational -- but the CELL is what
  // the checker published for the expression, which is `dynamic` whenever it
  // could not type the mixed operands (`number + null` is a strictNullChecks
  // error recovered as `any`). The census converts the operator's result
  // into that cell like any other store; a scalar or string cell is the
  // operator's own carrier already (an integer-narrowed cell included).
  const result = operation.result.representation
  const natural: Representation = relationalOperators.has(operation.operator)
    ? { kind: 'scalar', domain: 'boolean' }
    : first.representation.kind === 'string'
      ? { kind: 'string' }
      : { kind: 'scalar', domain: 'number' }
  const stored =
    result.kind === 'scalar' || result.kind === 'string' || representationKey(natural) === representationKey(result)
      ? expression
      : alignedValueText(ctx, 'emit.ts:compute-result', natural, result, expression)
  if (stored === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(natural)}->${representationKey(result)}`,
      `binary "${operation.operator}" produces a ${representationKey(natural)} that no installed conversion stores into ${representationKey(result)}`
    )
  }
  lines.push(`${name} = ${stored};`)
}

const emitParameter = (ctx: EmitContext, _lines: string[], operation: ParameterOperation): void => {
  const declared = ctx.abi?.parameters[operation.ordinal]
  if (!declared) {
    throw createCppEmitBlockedError(
      'call-abi:parameter',
      `reads ABI position ${operation.ordinal}, which this body's calling convention does not declare`
    )
  }
  // A formal the whole-program census settled is declared `long long` by this
  // body's own signature (`formalsOf`, translation-unit.ts). The ABI is
  // untouched -- it is what every caller, thunk and `CallableObject` agrees on
  // -- and the thunk converts across; here the formal simply already has the
  // carrier the body works in.
  if (ctx.narrowedFormals.has(operation.ordinal)) {
    // The formal already IS the narrowed carrier, so this is the alias below,
    // not a conversion: the signature carried the census's answer.
    defineValueAlias(ctx, operation.result, cppFormalName(operation.ordinal))
    return
  }
  // Otherwise the formal itself, for the reason `emitReceiver` states: it is a
  // local of this frame that nothing ever writes, so naming it is naming the
  // value the caller passed, and the copy that stood here was a retain and a
  // release (or a string's heap copy) for a name the frame already had.
  defineValueAlias(ctx, operation.result, cppFormalName(operation.ordinal))
}

/**
 * One JSX element, constructed through the host's element protocol.
 *
 * The emitter states only what the language states -- create with this tag,
 * then these props in order, then these children in order -- and hands each
 * step to an overloaded host entry point. What a prop *means* is genuinely not
 * decidable here: a style object, a string attribute, and an event handler are
 * three different operations on the host's node, and the thing that can tell
 * them apart is the C++ type of the value, which the host's own overload set
 * already dispatches on. Encoding that decision here instead would put the
 * framework's prop taxonomy inside the compiler, where it would immediately be
 * a second authority against the runtime's.
 *
 * The result must be a `native-handle`: a host element is opaque, and rendering
 * construction into a record carrier would produce a struct that compiles and
 * renders nothing.
 */

/**
 * `ToBoolean` of one value, per carrier.
 *
 * The table is the language's, not a convenience: `0` and `NaN` are false and
 * every other number true, an empty string is false and a one-space string
 * true, `null` and `undefined` are false, an absent optional is false, and
 * *every* object is true no matter what it holds. Writing any of these as a
 * C++ implicit conversion would get several of them wrong -- `NaN` converts to
 * `true`, and a `std::string` does not convert at all -- so each carrier gets
 * the expression that is exactly its rule, and a carrier with no stated rule
 * is refused rather than left to whatever `if (x)` happens to mean in C++.
 */
const emitTest = (ctx: EmitContext, lines: string[], operation: TestOperation): void => {
  const name = defineValue(ctx, operation.result)
  const hostNamespace = ctx.hostNamespaceReads.get(operation.value.value) ?? ctx.hostNamespaceValues.get(operation.value.value)
  const hostSingleton = ctx.hostClassReads.get(operation.value.value)
  const hostMethod = ctx.hostMemberReads.get(operation.value.value)
  if (hostNamespace !== undefined || hostSingleton !== undefined || hostMethod !== undefined) {
    // A plugin-declared namespace segment is a real, present object in the
    // source language even though the target fuses its member path and never
    // materializes that intermediate object. Host singletons and exact host
    // methods are the same kind of authenticated, always-present identity:
    // testing either for an optional-chain guard must not materialize a class
    // or method value. All three tests agree for every one: present, defined
    // and true.
    lines.push(`${name} = true;`)
    return
  }
  const text = operandText(ctx, operation.value)
  const carrier = operation.value.representation
  // Which question was asked travels on the operation, from the census that
  // recorded it, and is never re-derived from the carrier here: `if (x)` and
  // `x ?? y` over one `x` ask different questions and a carrier cannot tell
  // them apart.
  const answer =
    operation.predicate === 'is-present'
      ? presenceTestText(text, carrier)
      : operation.predicate === 'is-defined'
        ? definedTestText(text, carrier)
        : booleanTestText(text, carrier, isIntegerStorageValue(ctx, operation.value.value))
  lines.push(`${name} = ${answer};`)
}

/**
 * A conversion the graph made explicit, rendered by the one authority on what
 * a narrowing loads.
 *
 * `emit-narrowing.ts` already answers "given a value carried as X and wanted as
 * Y, what is the load" -- it is what a narrowed binding read renders -- and
 * asking it here rather than writing a second dereference is what keeps the two
 * from disagreeing. A pair it has no load for is refused by name: preflight
 * censused the conversion, so reaching this with no answer means the census and
 * the renderer disagree, which is worth saying out loud rather than papering
 * over with an implicit C++ conversion.
 */
const emitConvert = (ctx: EmitContext, lines: string[], operation: ConvertOperation): void => {
  // A deferred host method has no standalone C++ value. Optional chaining can
  // narrow/widen the callee between its property read, presence test and call;
  // carry the authenticated deferred invocation through those SSA views
  // without asking `operandText` to materialize a function the host never
  // supplied. Any non-call consumer still reaches `operandText` later and
  // fails closed as a host-method-value.
  if (ctx.hostMemberReads.has(operation.source.value)) return
  // A host singleton is a compile-time identity, including after the
  // statically-present arm of `globalThis?.singleton` is narrowed for a
  // following optional call. No object is converted or boxed here, so the
  // conversion renders nothing; the identity's travel onto the new SSA view is
  // stated by `emit-bindings.ts`'s `hostClassReadsOf`.
  if (ctx.hostClassReads.has(operation.source.value) && operation.result.representation.kind === 'native-handle') return
  // A host NAMESPACE is a path, not a value (`emit-namespaces.ts`), and a path
  // does not change by being viewed under another carrier. `export const
  // Accelerometer = typeof __gea_Accelerometer !== 'undefined' ?
  // __gea_Accelerometer : (undefined as unknown as typeof __gea_Accelerometer)`
  // merges the namespace with the host-absent arm into one path, then converts
  // that merge into the cell's own carrier before the binding write; the write
  // recognises the path and renders nothing (`emitBindingWrite`), so the
  // convert in between has to carry it rather than ask `operandText` for a
  // value the namespace never had.
  // The propagation itself is settled before this body rendered a line, by
  // `host-namespace-reads.ts`'s `hostNamespaceReadsOf`, which folds `convert`
  // into the same fixed point that finds the path in the first place. All this
  // has to ask is whether THIS conversion's result is one of the paths it
  // found -- a conversion of a namespace still renders nothing.
  if (ctx.hostNamespaceReads.has(operation.result.id)) return
  // Converting an expression to `void` evaluates the source and discards its
  // value. Evaluation has already happened in the source operation, so this
  // conversion only needs to publish the C++ void expression for any later
  // SSA use; it must not try to allocate storage for a carrier that has none.
  if (operation.result.representation.kind === 'void') {
    defineValueAlias(ctx, operation.result, '(void)0')
    return
  }
  const input = owningConversionInputText(ctx, operation.source, operation.result.representation, operandText(ctx, operation.source))
  // A load no program fact proves present (`ir/presence-proof.ts`) tests the
  // cell first: `presentOrThrow` hands back the same cell or raises.
  const sourceText = operation.presence === 'checked' ? `gea::host::presentOrThrow(${input})` : input
  // The node lowering named on this instruction, rendered by its recipe
  // (`alignedValueText` asks the census for the same pair and renders the
  // same node; a pair the census refused is its drift row, and the chain's).
  const named = ctx.conversions.nodeById(operation.conversionUse)
  const text =
    (named?.capability.kind === 'coercion'
      ? namedConversionText(ctx, 'emit.ts:1026', named, sourceText)
      : alignedValueText(ctx, 'emit.ts:1026', operation.source.representation, operation.result.representation, sourceText)) ??
    // A method value escaping into a receiver-less slot: the receiver is
    // recovered from the read itself (`emit-callable.ts`'s
    // `receiverBoundCallableText`), a fact of this context, not of the pair.
    receiverBoundCallableText(ctx, operation.source, operation.result.representation, sourceText)
  // A storage-free source converting into a real carrier is a branch flow
  // analysis proved dead, not a missing load: `undefined` is also `never`'s
  // carrier (`representation/primitives.ts`), and a pair the loads refuse can
  // only be reached when the source holds nothing. `var [d = 7] = []` is the
  // standing case -- the extraction past an empty tuple is `undefined`
  // outright, the default's present arm converts it to the bound `number`,
  // and the `is-defined` test guarding that arm is the constant `false`.
  // Rendered as the throw the call-site argument path already renders
  // (`emit-callable.ts`) so the dead arm does not block the live one.
  if (text === null && (operation.source.representation.kind === 'undefined' || operation.source.representation.kind === 'void')) {
    defineValueAlias(ctx, operation.result, `gea::host::unreachableValue<${cppTypeOf(operation.result.representation)}>()`)
    return
  }
  if (text === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(operation.source.representation)}->${representationKey(operation.result.representation)}`,
      `converts ${representationKey(operation.source.representation)} to ${representationKey(operation.result.representation)}, ` +
        `which no installed load performs (conversion use ${operation.conversionUse})`
    )
  }
  const consumed = transfersFormalConversion(ctx.consumingFormalConversions, operation.result.id) === 'move' ? `std::move(${text})` : text
  lines.push(`${defineValue(ctx, operation.result)} = ${consumed};`)
}

/**
 * `await p`.
 *
 * `gea::Promise<V>` is a settled-value box with no job queue
 * (`runtime/gea_runtime.h`'s `Promise` doc comment): the only promise this
 * runtime can ever construct is one whose result is already known. `await`
 * therefore renders as reading that value right now -- `.awaited()`, the
 * same synchronous-immediate answer `.then()` already commits to for the
 * identical reason (see that method's own doc comment) -- rather than a real
 * suspension, which this substrate has no coroutine primitive to express.
 *
 * The operand is not always a `promise` carrier: `await` accepts any
 * expression (`Awaited<T>` is `T` unchanged for a non-thenable `T`), and a
 * non-promise operand is already its own resolution, so it passes through
 * unchanged rather than calling a method that carrier does not have.
 *
 * And it is not always one of those two, either. A union of both --
 * `string | Promise<string>`, what every conditionally-async helper returns --
 * is a discriminant test away from either, and asking only `kind === 'promise'`
 * passed it through untouched, handing a `TaggedUnion<...>` to a consumer told
 * it would get the payload. `awaitedText` (prototype/emit-prototype-promise.ts)
 * is ECMA-262 27.2.4.7.1 `PromiseResolve` stated once, for all three shapes,
 * and shared with `Promise.all`, which resolves each element by the same rule.
 */
const emitAwait = (ctx: EmitContext, lines: string[], operation: AwaitOperation): void => {
  const text = operandText(ctx, operation.operand)
  const expression =
    awaitedText(ctx, 'emit.ts:emitAwait', operation.operand.representation, text, operation.result?.representation ?? null) ?? text
  if (!operation.result) {
    lines.push(`${expression};`)
    return
  }
  lines.push(`${defineValue(ctx, operation.result)} = ${expression};`)
}

/**
 * `yield x` -- a real suspension, unlike `await` above.
 *
 * The enclosing body's ABI result is `gea::Iterator<T>`, whose nested
 * `promise_type` (`runtime/gea_runtime.h`) is what makes this function a C++20
 * coroutine; `co_yield` stores the value in the frame and suspends, and the
 * `next()` that resumes it reads it back. That is v1's own mechanism
 * (`value_09_generator.h`'s `yield_value`/`yield_awaiter`), re-typed over the
 * concrete `E` the checker proved instead of v1's `gea_cpp_value`.
 *
 * The value is aligned to the cursor's element carrier on the way in, by the
 * same rule an argument written into a parameter slot is: a `Generator<number>`
 * yielding an `int`-carried expression must store the `double` the cursor
 * holds.
 *
 * `yield` with no operand is `yield undefined`, and this backend has no
 * `undefined` to yield into a typed cursor, so it is refused rather than
 * yielding a default-constructed element the program never wrote.
 */
const emitYield = (ctx: EmitContext, lines: string[], operation: YieldOperation): void => {
  const cursor = ctx.abi?.result
  if (cursor?.kind !== 'iterator') {
    throw createCppEmitBlockedError(
      'abrupt-edge:suspend',
      `appears in a body whose calling convention returns "${cursor ? representationKey(cursor) : 'nothing'}"; ` +
        'only a body returning an "iterator" cursor is emitted as a coroutine'
    )
  }
  // A bare `yield` yields `undefined`; it is spelled only when the cursor's
  // element carrier has an `undefined` to hold (`Iterator<Undefined>` for a
  // generator that yields nothing else, an optional or a sum carrying the
  // absence otherwise), never as a default-constructed element the program
  // did not write.
  const bareUndefined = operation.operand
    ? null
    : alignedValueText(ctx, 'emit.ts:1128', { kind: 'undefined' }, cursor.element, cppUndefinedValue)
  if (!operation.operand && bareUndefined === null) {
    throw createCppEmitBlockedError(
      'abrupt-edge:suspend',
      `yields no value; a bare \`yield\` yields \`undefined\`, which this cursor's "${representationKey(cursor.element)}" element carrier cannot hold`
    )
  }
  const yieldText = `(co_yield ${operation.operand ? alignedText(ctx, cursor.element, operation.operand, 'yield') : bareUndefined})`
  // Statement form: nobody reads what `next(v)` sent back, so the resumed
  // value -- whatever it turns out to be -- is evaluated and discarded, the
  // same as any other unread expression statement.
  if (operation.result === null) {
    lines.push(`${yieldText};`)
    return
  }
  // A yield whose own value IS read needs a real resume channel to read it
  // from: `TNext` collapsed to `undefined` (`representation/derive.ts`) means
  // there is no storage behind `yieldText`'s own value to convert, so this
  // refuses by name rather than converting a `void`/`undefined` expression
  // into whatever type the read expects.
  if (cursor.resume.kind === 'void' || cursor.resume.kind === 'undefined') {
    throw createCppEmitBlockedError(
      'abrupt-edge:suspend',
      "a yield whose own value is read needs the generator's resume channel (what `next(v)`/an abrupt `.return`/`.throw` sends back), " +
        'and this generator\'s own resume channel is "undefined" -- either TNext never resolved to a native carrier, or this ' +
        'generator is not annotated as one'
    )
  }
  const text = alignedValueText(ctx, 'emit.ts:1156', cursor.resume, operation.result.representation, yieldText)
  if (text === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(cursor.resume)}->${representationKey(operation.result.representation)}`,
      `resumes with "${representationKey(cursor.resume)}" where this read expects "${representationKey(operation.result.representation)}", ` +
        'and no installed conversion reconciles them'
    )
  }
  lines.push(`${defineValue(ctx, operation.result)} = ${text};`)
}

const emitReceiver = (ctx: EmitContext, _lines: string[], operation: ReceiverOperation): void => {
  const declared = ctx.abi?.receiver
  if (!declared) {
    throw createCppEmitBlockedError(
      'call-abi:receiver',
      "reads the frame's receiver, which this body's calling convention does not declare"
    )
  }
  // The formal IS the receiver, so the read names it rather than copying it --
  // the same argument `emit-bindings.ts` makes for a cell written once, and
  // stronger here: a formal is written zero times, by anyone, so no later value
  // exists for the alias to drift onto.
  //
  // The copy it removes is real work on every carrier a receiver can have. A
  // `gea::Ref` receiver pays a retain and a release per call for a name the
  // frame already had; measured on `bench/comparison/fixtures/method_calls.ts`,
  // whose loop is one method call, that pair alone was a third of the program
  // (57.4ms to 38.4ms).
  defineValueAlias(ctx, operation.result, cppReceiverName)
}

const emitGlobalThis = (ctx: EmitContext, lines: string[], operation: GlobalThisOperation): void => {
  const name = defineValue(ctx, operation.result)
  lines.push(`${name} = gea::runtime::globalThis();`)
}

/**
 * A name with no declaration anywhere -- reading it is a ReferenceError, not
 * a value this backend approximates or boxes (`ir/lower.ts`'s
 * `unresolvableThrows`). `throwReferenceError<T>()` is `[[noreturn]]`,
 * templated on this result's declared type, so it type-checks without
 * producing one -- the `[[noreturn]] void` idiom generalized to a value spot.
 */
const emitUnresolvableReference = (ctx: EmitContext, lines: string[], operation: UnresolvableReferenceOperation): void => {
  const name = defineValue(ctx, operation.result)
  const type = storageTypeOf(ctx, operation.result.id, operation.result.representation)
  lines.push(`${name} = gea::host::detail::throwReferenceError<${type}>();`)
}

/** Every non-terminator kind this file lowers. Anything else falls to the `default` and refuses, including kinds added after this file was written. */
const emitOperationStatements = (ctx: EmitContext, lines: string[], operation: IrNonTerminatorOperation): void => {
  switch (operation.kind) {
    case 'constant':
      emitConstant(ctx, lines, operation)
      return
    case 'binding-read':
      emitBindingRead(ctx, lines, operation)
      return
    case 'binding-write':
      emitBindingWrite(ctx, lines, operation)
      return
    case 'parameter':
      emitParameter(ctx, lines, operation)
      return
    case 'receiver':
      emitReceiver(ctx, lines, operation)
      return
    case 'global-this':
      emitGlobalThis(ctx, lines, operation)
      return
    case 'unresolvable-reference':
      emitUnresolvableReference(ctx, lines, operation)
      return
    case 'await':
      emitAwait(ctx, lines, operation)
      return
    case 'yield':
      emitYield(ctx, lines, operation)
      return
    case 'compute':
      emitCompute(ctx, lines, operation)
      return
    case 'call':
      emitCall(ctx, lines, operation)
      return
    case 'commonjs-require':
      lines.push(`${defineValue(ctx, operation.result)} = ${cppCommonJsModuleName(operation.target)}();`)
      return
    case 'commonjs-binding':
      // Publication forces every unproved wrapper read to `dynamic`; a
      // non-dynamic module result is therefore the consumed source proof, not
      // a second backend shape heuristic.
      if (operation.result.representation.kind !== 'dynamic') {
        if (operation.global !== 'module') {
          throw createCppEmitBlockedError(
            'native-boundary:commonjs-binding',
            `native CommonJS record proof reached the "${operation.global}" wrapper; only the exact module record has a native carrier`
          )
        }
        lines.push(`${defineValue(ctx, operation.result)} = ${cppCommonJsRecordName(operation.owner)}();`)
      } else {
        lines.push(`${defineValue(ctx, operation.result)} = gea::commonjs::${operation.global}();`)
      }
      return
    case 'commonjs-binding-set':
      lines.push(`gea::commonjs::setBinding("${operation.global}", ${operandText(ctx, operation.value)});`)
      return
    case 'super-initialize':
      emitSuperInitialize(ctx, lines, operation)
      return
    case 'reparent-constructor':
      lines.push(
        `gea::reparentNativeClass<${cppClassName(operation.derived)}, ${cppClassName(operation.base)}>(` +
          `${operandText(ctx, operation.classValue)}.environment, ${operandText(ctx, operation.heritage)}.environment);`
      )
      return
    case 'allocate-callable':
      emitAllocateCallable(ctx, lines, operation)
      return
    case 'bind-callable':
      emitBindCallable(ctx, lines, operation)
      return
    case 'allocate-constructor':
      emitAllocateConstructor(ctx, lines, operation)
      return
    case 'construct':
      emitConstruct(ctx, lines, operation)
      return
    case 'get': {
      const priorLength = ctx.reusedStringLengths.get(operation.result.id)
      if (priorLength !== undefined) {
        lines.push(`${defineValue(ctx, operation.result)} = ${operandText(ctx, priorLength)};`)
        return
      }
      emitGet(ctx, lines, operation)
      return
    }
    case 'set':
      emitFieldStore(ctx, classTableLines(ctx, lines, operation.receiver.value), operation, 'set')
      return
    case 'define-own-property':
      emitFieldStore(ctx, classTableLines(ctx, lines, operation.receiver.value), operation, 'define-own-property')
      return
    case 'spread-copy':
      emitSpreadCopy(ctx, lines, operation)
      return
    // Answered for the one receiver with a runtime property table, refused by
    // name for every other carrier; both rules live with the dynamic machinery.
    case 'delete':
      emitDeleteOperation(ctx, lines, operation)
      return
    case 'has-property':
      emitHasProperty(ctx, lines, operation)
      return
    case 'allocate-ordinary-object':
      lines.push(`${defineValue(ctx, operation.result)} = gea::Value::object();`)
      return
    case 'allocate-record':
      emitAllocateRecord(ctx, classTableLines(ctx, lines, operation.result.id), operation)
      return
    case 'allocate-regexp':
      emitAllocateRegExp(ctx, lines, operation)
      return
    case 'allocate-template-object':
      emitAllocateTemplateObject(ctx, lines, operation)
      return
    case 'allocate-array-object':
      emitAllocateArrayObject(ctx, lines, operation)
      return
    case 'get-iterator':
      emitGetIterator(ctx, lines, operation)
      return
    case 'iterator-next':
      emitIteratorNext(ctx, lines, operation)
      return
    case 'iterator-done':
      emitIteratorDone(ctx, lines, operation)
      return
    case 'iterator-close':
      emitIteratorClose(ctx, lines, operation)
      return
    case 'element':
      emitElement(ctx, lines, operation)
      return
    case 'element-prop':
      emitElementProp(ctx, lines, operation)
      return
    case 'element-child':
      emitElementChild(ctx, lines, operation)
      return
    case 'test':
      emitTest(ctx, lines, operation)
      return
    case 'convert':
      emitConvert(ctx, lines, operation)
      return
    case 'merge-live-arm-rebuild':
      emitMergeLiveArmRebuild(ctx, lines, operation)
      return
    case 'phi':
      // The variable is declared with every other local and written by each
      // predecessor; there is nothing left to render where it is read.
      return
    default:
      throw createCppEmitBlockedError(
        `runtime-helper:operation:${operation.kind}`,
        `no C++ rendering is implemented for the "${operation.kind}" operation yet`
      )
  }
}

/** A block's assigned `goto` label. Absence means a jump names a block outside this body's own `blockOrder`, an IR-verification bug, not a rendering gap. */
const requireBlockLabel = (labels: ReadonlyMap<IrBlockId, string>, block: IrBlockId): string => {
  const label = labels.get(block)
  if (label === undefined)
    throw new Error(`ir block ${block} has no assigned label; every block in this body must be labeled before emission`)
  return label
}

/**
 * `text` with one outermost parenthesis layer removed, when that layer wraps
 * the whole of it.
 *
 * `operandText` renders a binary expression fully parenthesized, because it
 * does not know what it will be spliced into and precedence is not something a
 * renderer may guess at. A branch condition is the one place that layer is
 * always redundant: `if (...)` is itself a grouping, so `if (((b0) == (3)))`
 * says exactly what `if ((b0) == (3))` says -- and clang reads the first as a
 * person who meant `=` and wrote `==`, raising -Wparentheses-equality on every
 * one. Measured across the emitted units in this tree: roughly 350 of them,
 * 61 in `button-tetris` alone. Not a large number, but a warning that is always
 * present is a warning nobody reads.
 *
 * Only the OUTER layer, and only when it really is one: the scan below returns
 * the text unchanged for `(a) == (b)`, whose first parenthesis closes at index
 * 2, and for a leading cast like `(bool)(x)`. Quoted runs are skipped whole,
 * because an emitted string literal may contain either parenthesis --
 * `gea_class_decl_f3_545` and every other name literal proves nothing about
 * nesting.
 */
const unwrapConditionParentheses = (text: string): string => {
  if (text.length < 2 || text[0] !== '(' || text[text.length - 1] !== ')') return text
  let depth = 0
  let quote = ''
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quote !== '') {
      if (character === '\\') index += 1
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(') depth += 1
    else if (character === ')') {
      depth -= 1
      // Closed before the end, so the opening parenthesis wrapped a part and
      // not the whole -- there is nothing redundant to take off.
      if (depth === 0 && index !== text.length - 1) return text
    }
  }
  // An unbalanced count means the text is not what this reads it as (an
  // unterminated literal, say). Leave it exactly as rendered.
  return depth === 0 ? text.slice(1, -1) : text
}

/**
 * One `goto` a block's exit spells: to which label, and under what.
 *
 * `emitTerminator` renders these and `threadedFlowOf` counts them, so that
 * the set of labels a body writes is exactly the set some rendered `goto`
 * names -- one rule, read by both, never a second copy that drifts.
 */
interface SpelledExit {
  readonly label: string
  readonly condition: 'always' | 'when-true' | 'when-false'
}

/**
 * The `goto`s a `jump` or `branch` renders, given the label of the block
 * rendered immediately after it (`null` when nothing follows or the caller
 * does not know).
 *
 * Two `goto`s rather than an `if`/`else` pair: the blocks this names are
 * siblings in one flat sequence, and wrapping either in a C++ block would put
 * every declaration inside it out of the other blocks' reach. Within that
 * shape, three things spell less than the IR says:
 *
 * - a jump to the very next block is the fall-through it already is and
 *   spells nothing (`goto block1; block1:` was every loop's entry);
 * - a branch on a literal -- `while (true)`, `for (;;)` -- and a branch whose
 *   two arms thread to one block are each a jump, and render as one: `if
 *   (true) goto block3;` leaves the untaken arm behind as a block nothing
 *   reaches, which `threadedFlowOf` has already left out;
 * - a branch one of whose arms is the next block spells only the other arm,
 *   negating the condition when the TAKEN arm is the one that falls through.
 */
const spelledExitsOf = (
  ctx: EmitContext,
  labels: ReadonlyMap<IrBlockId, string>,
  terminator: IrTerminatorOperation,
  nextLabel: string | null
): readonly SpelledExit[] => {
  if (terminator.kind === 'jump') {
    const label = requireBlockLabel(labels, terminator.target)
    return label === nextLabel ? [] : [{ label, condition: 'always' }]
  }
  if (terminator.kind !== 'branch') return []
  const whenTrue = requireBlockLabel(labels, terminator.whenTrue)
  const whenFalse = requireBlockLabel(labels, terminator.whenFalse)
  const known = ctx.booleanConstants.get(terminator.condition.value)
  if (known !== undefined || whenTrue === whenFalse) {
    const only = known === false ? whenFalse : whenTrue
    return only === nextLabel ? [] : [{ label: only, condition: 'always' }]
  }
  if (whenFalse === nextLabel) return [{ label: whenTrue, condition: 'when-true' }]
  if (whenTrue === nextLabel) return [{ label: whenFalse, condition: 'when-false' }]
  return [
    { label: whenTrue, condition: 'when-true' },
    { label: whenFalse, condition: 'always' }
  ]
}

const emitTerminator = (
  ctx: EmitContext,
  lines: string[],
  labels: ReadonlyMap<IrBlockId, string>,
  isSingleBlock: boolean,
  terminator: IrTerminatorOperation,
  nextLabel: string | null = null
): void => {
  switch (terminator.kind) {
    case 'jump':
    case 'branch': {
      // A single-block body has no other block to name: falling off the end
      // of this text is exactly what the jump means, so it renders as nothing
      // rather than a `goto` to a label this file never assigns.
      if (isSingleBlock) return
      const condition = terminator.kind === 'branch' ? terminator.condition : null
      for (const exit of spelledExitsOf(ctx, labels, terminator, nextLabel)) {
        if (exit.condition === 'always' || condition === null) {
          lines.push(`goto ${exit.label};`)
          continue
        }
        const text = unwrapConditionParentheses(operandText(ctx, condition))
        lines.push(exit.condition === 'when-true' ? `if (${text}) goto ${exit.label};` : `if (!(${text})) goto ${exit.label};`)
      }
      return
    }
    case 'return':
      emitReturn(ctx, lines, terminator)
      return
    case 'throw':
      // A C++ `throw` of the value's own carrier, not of a boxed wrapper: what
      // the program throws is whatever it constructed, and re-typing it on the
      // way out would make the thing a handler catches different from the thing
      // the `throw` statement named.
      //
      // No handler is claimed alongside this. That is not an oversight: an
      // uncaught `throw` terminating the process is exactly what an uncaught
      // ECMAScript exception does, so this is complete on its own, while `try`
      // needs a catch-side carrier decision this does not make and does not
      // pre-empt.
      lines.push(`throw ${operandText(ctx, terminator.value)};`)
      // A generator whose body throws before it ever yields or returns
      // (`function* () { throw new Test262Error() }`) has no other keyword to
      // make it a coroutine, and C++ would compile it as a plain function
      // that throws AT THE CALL rather than on the first `next()`. The
      // unreachable `co_return` after the throw is what keeps the frame a
      // coroutine, so the throw surfaces where the language says it does.
      if (ctx.generatorBody) lines.push('co_return;')
      return
    case 'switch':
      throw createCppEmitBlockedError(
        `runtime-helper:control:${terminator.kind}`,
        `no C++ rendering is implemented for the "${terminator.kind}" terminator yet`
      )
  }
}

/**
 * One operation's statements, withheld where the census proved they may
 * render at the use instead.
 *
 * The withholding is recognized from what the emitter did, not predicted: a
 * kind that renders exactly one assignment to the name it just minted is the
 * only shape that can move, and any emitter that rendered anything else --
 * several statements, a name some other construct declares, nothing at all --
 * falls through unchanged. That is what keeps this a rendering choice rather
 * than a second authority over what an operation means: it can only ever
 * decline.
 */
/**
 * Where a candidate class table's own lines go: into that table's buffer, so
 * the `class` prop can drop them if it spells the table away. See
 * `EmitContext.classTableRoots`.
 */
const classTableLines = (ctx: EmitContext, lines: string[], value: IrValueId): string[] => {
  const root = ctx.classTableRoots.get(value)
  if (root === undefined) return lines
  const pending = ctx.pendingClassTableLines.get(root)
  if (pending !== undefined) return pending
  const opened: string[] = []
  ctx.pendingClassTableLines.set(root, opened)
  return opened
}

const emitOperation = (ctx: EmitContext, lines: string[], operation: IrNonTerminatorOperation): void => {
  try {
    const result = resultOfIrOperation(operation)
    if (result !== null && ctx.deadValues.has(result.id)) {
      settleDeadCalleeSideEffects(ctx, operation)
      return
    }
    if (result === null || !ctx.deferrable.has(result.id)) {
      emitOperationStatements(ctx, lines, operation)
      return
    }
    const lineMark = lines.length
    const declarationMark = ctx.declarations.length
    emitOperationStatements(ctx, lines, operation)
    // An array literal withheld whole records its own elements instead
    // (`emit-arrays.ts`) and has neither a name nor a statement to reclaim.
    if (ctx.pendingPacks.has(result.id)) return
    const name = ctx.valueNames.get(result.id)
    if (name === undefined) return
    if (lines.length !== lineMark + 1 || ctx.declarations.length !== declarationMark + 1) return
    if (ctx.declarations[declarationMark]?.name !== name) return
    const statement = lines[lineMark] ?? ''
    const prefix = `${name} = `
    if (!statement.startsWith(prefix) || !statement.endsWith(';')) return
    ctx.declarations.pop()
    lines.pop()
    ctx.deferredTexts.set(result.id, `(${statement.slice(prefix.length, statement.length - 1)})`)
  } catch (error) {
    if (isCppEmitBlockedError(error)) {
      const result = resultOfIrOperation(operation)
      error.message += ` while emitting ${operation.kind}${result === null ? '' : ` -> ${result.id}`}${operation.lineage === null ? '' : ` from ${operation.lineage}`}`
    }
    if (error instanceof Error && error.message.startsWith('ir value ')) {
      const result = resultOfIrOperation(operation)
      error.message += ` while emitting ${operation.kind}${result === null ? '' : ` -> ${result.id}`}${operation.lineage === null ? '' : ` from ${operation.lineage}`}`
    }
    throw error
  }
}

/**
 * What a dead callee producer still has to do, now that `ctx.directCallees`
 * itself is populated up front from `CallOperation.target` (`emitBody`'s own
 * walk, above) rather than by each producer's live emitter as a side effect
 * of rendering: nothing about NAMING the callee is left for this function,
 * only the two side effects that are tied to the producer's OWN skipped
 * render rather than to the eventual call.
 *
 * `ir/dead-values.ts` counts a directly-called callee as unread precisely
 * because `emit-callable.ts` spells such a call as `body(args)`, and it
 * decides that with its own `directCallee` predicate -- a copy of the same
 * three tests (allocate-callable/binding-read/get) this file used to restate
 * here as writes. That predicate is unrelated to `CallOperation.target` (it
 * answers for a PRODUCER value, not a call) and stays as its own render-time
 * decision; only the direct-callee NAME it used to also mint moved to the
 * `emitBody`-level pass.
 */
const settleDeadCalleeSideEffects = (ctx: EmitContext, operation: IrNonTerminatorOperation): void => {
  if (operation.kind === 'allocate-callable') {
    if (ctx.captures.of(operation.functionId).kind === 'none') {
      // What is left here once `thunkValues` is a sealed fact
      // (`ir/facts.ts`'s `bodyValueOriginsOf`): the thunk's TEXT. A captureless
      // thunk is exactly the one the dead-value rule elides -- its only call
      // is by name -- so its producer never renders, and the one use that
      // does need a value has to be able to spell it. It is spelled as the
      // prvalue it is, a body pointer and a null environment.
      //
      // The registration this used to also do is why the field moved: the
      // reader is `emit-jsx.ts`'s `reactiveThunkPlan`, which re-runs the thunk
      // behind a slot's call on every change of a cell that body reads, and a
      // registration performed as a side effect of rendering was missing for
      // exactly the producer whose render is skipped. Every such slot fell to
      // the once-only path -- the piece in button-tetris drew at its spawn
      // position and never moved, while the plain-text FPS slot beside it kept
      // updating.
      const carrier = operation.result.representation
      if (carrier.kind === 'function-value-dispatch' && carrier.abi.parameters.length === 0 && carrier.abi.receiver === null) {
        ctx.deferredTexts.set(operation.result.id, `${cppTypeOf(carrier)}{&${cppThunkName(operation.functionId)}, nullptr}`)
      }
    }
    return
  }
}

/**
 * The control flow a body renders once every block that renders nothing is
 * jumped over, and every block nothing reaches is left out.
 *
 * The IR builds a block per structured construct -- a `continue`'s target, a
 * loop's latch, the join after an `if` -- and most of them hold no
 * operations of their own, only a jump: `block2: goto block3;`. 153 of the
 * 688 blocks of `examples/apps/weather`'s unit were that. Each one is a label
 * and an unconditional jump the C++ compiler threads away at -O2, and a line
 * a reader has to follow by hand at -O0.
 *
 * Three answers, all from the emitter's own records rather than from the
 * rendered text:
 *
 * - a block whose every operation is dead or relocated, which writes no
 *   merge, hosts no hoisted read, no fill loop and no dense window, and ends
 *   in a `jump`, FORWARDS: its label becomes the label of the block the chain
 *   ends at, so every `goto` to it lands there directly, and the block itself
 *   is not rendered. A chain that closes on itself is an empty infinite loop
 *   and renders as it was;
 * - a block no path from the entry reaches -- once a branch on a literal
 *   `true` is the jump it is (`emitTerminator`), and once a counted fill
 *   loop's header goes straight to its exit -- is left out, together with the
 *   label nothing names;
 * - a block's label is written only when some rendered jump names it. The
 *   entry block and every fall-through target were labels the C++ compiler
 *   warned about (43 `-Wunused-label` in the same unit).
 *
 * A body with a try region is left exactly as it was: `renderTryRegion`
 * renders a region's blocks as one chunk with its own labels, and a
 * forwarding decision made here would have to be mirrored there.
 */
interface ThreadedFlow {
  readonly labels: ReadonlyMap<IrBlockId, string>
  /** Blocks not rendered: forwarded over, or reached by nothing. */
  readonly skipped: ReadonlySet<IrBlockId>
  /** Labels some rendered `goto` names, and which therefore get a label line. */
  readonly labeled: ReadonlySet<string>
  /** For each rendered block, the label of the block rendered right after it -- the one a jump to falls through to. */
  readonly nextLabel: ReadonlyMap<IrBlockId, string>
}

const threadedFlowOf = (
  ctx: EmitContext,
  body: IrBody,
  labels: ReadonlyMap<IrBlockId, string>,
  hoists: HoistPlan,
  mergeWrites: ReadonlyMap<IrBlockId, readonly unknown[]>
): ThreadedFlow => {
  if (body.tryRegions.length > 0 || (body.iteratorCloseRegions?.length ?? 0) > 0 || body.blockOrder.length === 1) {
    return { labels, skipped: new Set(), labeled: new Set(labels.values()), nextLabel: new Map() }
  }
  // A literal is spelled at its uses (`spellConstants`) and a merge is written
  // by its predecessors (`mergeWritesOf`): neither renders where it sits. A
  // read hoisted INTO a block renders there -- unless it is one of those, as
  // the `true` of a `while (true)` hoisted to the loop's preheader is.
  const rendersNothingAtOrigin = (operation: IrNonTerminatorOperation): boolean => {
    if (operation.kind === 'constant' || operation.kind === 'phi') return true
    const result = resultOfIrOperation(operation)
    return result !== null && (ctx.deadValues.has(result.id) || hoists.relocated.has(result.id))
  }
  const rendersNothingWhenHoisted = (operation: IrNonTerminatorOperation): boolean => {
    if (operation.kind === 'constant' || operation.kind === 'phi') return true
    const result = resultOfIrOperation(operation)
    return result !== null && ctx.deadValues.has(result.id)
  }
  const rendersNothing = (block: IrBlock): boolean =>
    block.operations.every(rendersNothingAtOrigin) &&
    (mergeWrites.get(block.id) ?? []).length === 0 &&
    // A relocated operation renders here, in its destination block. Counting
    // it as absent a second time lets the flow thread this block away and
    // leaves later users with no dominating C++ definition.
    (hoists.into.get(block.id) ?? []).every(rendersNothingWhenHoisted) &&
    !ctx.fillLoops.has(block.id) &&
    ![...ctx.denseGroups.values()].some((group) => group.preheader === block.id)
  const forwarding = new Map<IrBlockId, IrBlockId>()
  for (const block of body.blocks.values()) {
    if (block.id !== body.entry && block.terminator.kind === 'jump' && rendersNothing(block))
      forwarding.set(block.id, block.terminator.target)
  }
  const resolve = (id: IrBlockId): IrBlockId => {
    const seen = new Set<IrBlockId>()
    let at = id
    while (forwarding.has(at) && !seen.has(at)) {
      seen.add(at)
      at = forwarding.get(at) ?? at
    }
    return at
  }
  for (let settled = false; !settled;) {
    settled = true
    for (const id of [...forwarding.keys()]) {
      if (!forwarding.has(resolve(id))) continue
      forwarding.delete(id)
      settled = false
    }
  }
  const aliased = new Map(labels)
  for (const id of forwarding.keys()) aliased.set(id, requireBlockLabel(labels, resolve(id)))
  const successorsOf = (block: IrBlock): readonly IrBlockId[] => {
    const fill = ctx.fillLoops.get(block.id)
    if (fill) return [fill.exit]
    const terminator = block.terminator
    switch (terminator.kind) {
      case 'jump':
        return [terminator.target]
      case 'branch': {
        const known = ctx.booleanConstants.get(terminator.condition.value)
        return known === undefined ? [terminator.whenTrue, terminator.whenFalse] : [known ? terminator.whenTrue : terminator.whenFalse]
      }
      case 'switch':
        return [...terminator.cases.map((entry) => entry.target), terminator.defaultTarget]
      default:
        return []
    }
  }
  const reachable = new Set<IrBlockId>()
  const pending: IrBlockId[] = [body.entry]
  while (pending.length > 0) {
    const id = pending.pop()
    if (id === undefined || reachable.has(id)) continue
    reachable.add(id)
    const block = body.blocks.get(id)
    if (!block) continue
    for (const next of successorsOf(block)) {
      const target = resolve(next)
      if (!reachable.has(target)) pending.push(target)
    }
  }
  const rendered = body.blockOrder.filter((id) => reachable.has(id))
  const nextLabel = new Map<IrBlockId, string>()
  rendered.forEach((id, index) => {
    const next = rendered[index + 1]
    if (next !== undefined) nextLabel.set(id, requireBlockLabel(aliased, next))
  })
  const labeled = new Set<string>()
  for (const id of rendered) {
    const block = body.blocks.get(id)
    if (!block) continue
    // A counted fill loop's header always spells the `goto` to its exit (`emitFillLoop`).
    const fill = ctx.fillLoops.get(id)
    if (fill) {
      labeled.add(requireBlockLabel(aliased, fill.exit))
      continue
    }
    for (const exit of spelledExitsOf(ctx, aliased, block.terminator, nextLabel.get(id) ?? null)) labeled.add(exit.label)
  }
  return { labels: aliased, skipped: new Set(body.blockOrder.filter((id) => !reachable.has(id))), labeled, nextLabel }
}

/** One `blockN` label per block, in `blockOrder`, so a forward jump (a loop back-edge included) always resolves before any block renders. */
const blockLabelsOf = (order: readonly IrBlockId[]): ReadonlyMap<IrBlockId, string> => {
  const labels = new Map<IrBlockId, string>()
  order.forEach((block, index) => labels.set(block, `block${index}`))
  return labels
}

/**
 * The C++ statements one lowered body renders to, as artifacts for the
 * emission boundary.
 *
 * `hostMembers` is every host spelling this compilation installed -- the
 * backend's own plus every plugin's. It is a parameter rather than an import
 * because which host is in front of the compiler is a property of the
 * compilation, not of this file.
 *
 * `deriver` is what `targets/cpp/emit-properties.ts` asks for a receiver's
 * own declared field representation, to widen a concrete value into a
 * `dynamic` field the same way this function's own `return` handling widens
 * into a `dynamic` ABI result -- see citations.md finding 1.
 *
 * `captures` defaults to `emptyCaptureIndex` (every owner closes over
 * nothing) so every existing caller keeps compiling and behaving exactly as
 * before; `translation-unit.ts` is the one caller that has an index to pass,
 * built once for the whole program by `targets/cpp/captures.ts`.
 */
/**
 * The namespace every incoming value of a merge stands for, or `null`.
 *
 * `null` unless at least one arm is a namespace and every other arm is either
 * the same namespace or an absent constant -- see the call site for why an
 * absent arm is the one thing that may accompany it.
 */
export const emitBody = (
  body: IrBody,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  hosts: HostSpellings,
  deriver: RepresentationDeriver,
  wellKnownSymbols: ReadonlyMap<DeclarationId, string> = new Map(),
  captures: CaptureIndex = emptyCaptureIndex,
  // No default: `symbolKeys`/`templateObjects` are ONE table for the whole
  // program (`translation-unit.ts`'s own comment on its `templateObjects`
  // says why -- a tagged-template site's object must be the same one across
  // every body that reaches it). A default `new Map()` here would be a
  // second creation site for state that has exactly one legitimate owner;
  // `translation-unit.ts` is this function's only caller and always passes
  // its own program-wide map, so the default was dead and only invited a
  // future caller to silently get an empty, per-call table instead of the
  // shared one (scripts/architecture.mjs's EmitContext Map/Set check).
  symbolKeys: Map<string, string>,
  templateObjects: Map<string, TemplateObjectDefinition>,
  directCallableBindings: ReadonlyMap<DeclarationId, FunctionId> = new Map(),
  // `virtualDispatch` is every `class key` with a dispatch member (`virtual-methods.ts`);
  // `narrowedStorage`/`narrowedFormals` are what the integer census settled here.
  virtualDispatch: ReadonlyMap<string, CallableAbi> = new Map(),
  narrowedStorage: IntegerStorageFacts = { reads: new Map(), integral: new Set(), magnitudes: new Map() },
  narrowedFormals: ReadonlySet<number> = new Set(),
  repeatedConstructors: ReadonlyMap<DeclarationId, DeclarationId> = new Map(),
  dyingArguments: ReadonlySet<IrValueId> = new Set(),
  instantiation: InstantiationFacts = noInstantiationFacts,
  abiOfCallable: (callable: FunctionId) => IrBody['abi'] = () => null,
  hostMethodAliases: ReadonlyMap<DeclarationId, HostMethodAlias> = new Map(),
  callableMemberCandidates: ReadonlyMap<string, FunctionId> = new Map(),
  borrowableMemberBodies: ReadonlySet<FunctionId> = new Set(),
  stableBorrowEntries: ReadonlyMap<string, StableBorrowEntry> = new Map(),
  printerDrift: PrinterDrift[] = [],
  conversions: ConversionCensus | null = null,
  nativeSelections: ReadonlyMap<string, NativeSelectionHelper> | undefined = undefined,
  callableIdentityDemand: CallableIdentityDemand = observesEveryCallableIdentity,
  nativeIntegrityRestricted = true,
  fixedFieldStateConstant = false
): readonly CppArtifact[] => {
  // Every fact this body settles before a single line renders, computed here
  // -- from `body` and the plain, already-available inputs above -- and
  // handed to `createEmitContext` as one argument instead of mutated onto the
  // context afterward. See `EmitBodyFacts`'s own doc
  // (the no-write-during-render
  // rule") for why this stopped being twelve `ctx.field.add(...)` calls.
  const stableBorrowActuals = stableBorrowActualsOf(body, (declaration) => {
    const placement = placements.get(declaration)
    return placement?.storage.kind === 'local' && placement.storage.owner === body.sourceOwner && !captures.isBoxed(declaration)
      ? placement.representation
      : null
  })
  // A read has to know what the REST of the body does to the cell it reads.
  // `emit-bindings.ts` lets a host object's read name its cell rather than
  // copy out of it, and that identity only holds while the cell keeps
  // pointing at the one object -- which a body that rebinds it cannot
  // promise, and which the linear emit would otherwise discover only after
  // the read had already rendered.
  const receiverValues = new Set<IrValueId>()
  const bindingWriteCounts = new Map<DeclarationId, number>()
  let callsSuper = false
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      // Censused in the same pass, for `EmitBodyFacts.receiverValues`: a
      // member access has to know whether its receiver came from `super`, and
      // the operation that defines it is the only place that says so.
      if (operation.kind === 'receiver') receiverValues.add(operation.result.id)
      if (operation.kind === 'super-initialize') callsSuper = true
      if (operation.kind !== 'binding-write') continue
      bindingWriteCounts.set(operation.declaration, (bindingWriteCounts.get(operation.declaration) ?? 0) + 1)
    }
  }
  const owningClass = [...classes.values()].find((layout) => layout.constructor === body.sourceOwner) ?? null
  const constructorOf = owningClass
    ? { layout: owningClass, derived: constructedBaseOf(owningClass) !== null || owningClass.nativeBase !== null, callsSuper }
    : null
  const formalInputs = ownedFormalInputsOf(body)
  const ownedDyingValues = new Set<IrValueId>([...ownedDyingValuesOf(body), ...formalInputs.arguments])
  const origins = bodyValueOriginsOf(body)
  const hostClassReads = hostClassReadsOf(body, placements)
  const classObjectReads = classObjectReadsOf(body, placements)
  const hostNamespaces = hostNamespaceReadsOf(body, placements, hosts, origins.staticKeyTexts)
  // Settled here rather than as a post-construction merge (invariant 5, 2.3):
  // both are pure walks over `body` plus a plain, already-available input --
  // `staticKeyTexts` (== `origins.staticKeyTexts`) and `abiOfCallable` -- with
  // no dependency on `ctx` at all, unlike the seventeen `EmitBodyPrepassFacts`
  // fields below, whose collectors genuinely do need one.
  const functionSources = functionSourceReadsOf(origins.staticKeyTexts, body)
  const directCalleeFacts = directCalleesOf(body, abiOfCallable)
  const bodyFacts: EmitBodyFacts = {
    generatorBody: body.generator === true,
    receiverValues,
    bindingWriteCounts,
    constructorOf,
    ownedDyingValues,
    consumingFormalConversions: formalInputs.conversions,
    classTableRoots: classTableRootsOf(body),
    stableBorrowActuals,
    computeOrigins: origins.computeOrigins,
    propertyReadOrigins: origins.propertyReadOrigins,
    bindingReadDeclarations: origins.bindingReadDeclarations,
    conversionSources: origins.conversionSources,
    callCallees: origins.callCallees,
    calleeOnlyValues: origins.calleeOnlyValues,
    recordFieldSources: origins.recordFieldSources,
    thunkValues: origins.thunkValues,
    hostClassReads,
    classObjectReads,
    // Every deferred host member read, decided from the IR, the unioned host
    // tables and `hostClassReads` -- all settled -- before this body renders a
    // line. The census was measured against the render-time map it replaces on
    // both emitted sets (154 + 281 programs): no read the printer recorded was
    // missing from it and none differed, and every extra was the unconditional
    // `<value>:present` twin nothing reads unless a narrowing mints one.
    hostMemberReads: hostMemberReadsOf(body, hosts, origins.staticKeyTexts, hostClassReads, hostMethodAliases),
    valueCellReads: origins.valueCellReads,
    staticKeyTexts: origins.staticKeyTexts,
    hostNamespaceReads: hostNamespaces.reads,
    hostNamespaceValues: hostNamespaces.values,
    hostFunctionReads: hostNamespaces.functionReads,
    functionSourceReads: functionSources.reads,
    functionSourceSnapshotNames: functionSources.names,
    directCallees: directCalleeFacts.directCallees,
    directCalleeAbis: directCalleeFacts.directCalleeAbis
  }
  const { ctx, prepass } = createEmitContext(
    body.abi,
    body.sourceOwner,
    placements,
    classes,
    hosts,
    deriver,
    bodyFacts,
    wellKnownSymbols,
    captures,
    symbolKeys,
    templateObjects,
    directCallableBindings,
    virtualDispatch,
    narrowedFormals,
    repeatedConstructors,
    dyingArguments,
    instantiation,
    abiOfCallable,
    hostMethodAliases,
    callableMemberCandidates,
    borrowableMemberBodies,
    stableBorrowEntries,
    printerDrift,
    conversions,
    nativeSelections,
    callableIdentityDemand,
    nativeIntegrityRestricted,
    fixedFieldStateConstant
  )
  // `ownedValues` stays a genuine render-time OUTPUT buffer (`EmitContext`'s
  // own doc: `defineValue` grows it as each operation's result is named) --
  // unlike `ownedDyingValues` above, a formal argument's membership in it is
  // not independent of the naming machinery, so it is set on `ctx` itself
  // rather than folded into `EmitBodyFacts`.
  for (const value of formalInputs.arguments) ctx.ownedValues.add(value)
  // Every deferred prototype-method read, composed from the carrier resolvers'
  // own claims before this body renders a line. It is filled onto `ctx` rather
  // than folded into `EmitBodyFacts` because two of the claims need the
  // context itself -- `objectViewFrom` is the authority for a known shape's
  // fields, and it reads the layouts `createEmitContext` assembles.
  for (const [value, read] of prototypeMethodReadsOf(ctx, body)) prepass.prototypeMethodReads.set(value, read)
  // `class-layout.ts`'s `lazyCalleeReadsOf` needs `ctx.abiOfCallable` and
  // `ctx.classes`, the identical reason `prototypeMethodReadsOf` above is
  // filled here rather than folded into `EmitBodyFacts`.
  for (const value of lazyCalleeReadsOf(ctx, body)) prepass.lazyCalleeReads.add(value)
  // The receiver every method-value read keeps for the call that consumes it,
  // asked of the class layout rather than recorded by whichever resolver
  // happened to spell the value.
  for (const [value, receiver] of directCallReceiversOf(ctx, body)) prepass.directCallReceivers.set(value, receiver)
  for (const [value, callee] of virtualCalleesOf(ctx, body)) prepass.virtualCallees.set(value, callee)
  for (const [value, read] of unionMethodReadsOf(ctx, body)) prepass.unionMethodReads.set(value, read)
  // A member read nothing but `typeof` consumes, off arms that disagree about
  // the member; the read renders nothing and the `typeof` renders the dispatch.
  for (const [value, read] of unionMemberTypeofReadsOf(ctx, body)) prepass.unionMemberTypeofReads.set(value, read)
  const reactive = reactiveOriginsOf(ctx, body)
  for (const [value, origin] of reactive.origins) prepass.reactiveOrigins.set(value, origin)
  for (const [declaration, origin] of reactive.bindingOrigins) prepass.reactiveBindingOrigins.set(declaration, origin)
  for (const [value, read] of reactive.fieldReads) prepass.reactiveFieldReads.set(value, read)
  // `functionSourceReads`/`functionSourceSnapshotNames` (both writes of no
  // C++ at all, from `functionSourceReadsOf`) and `directCallees`/
  // `directCalleeAbis` (the projection of `CallOperation.target` --
  // `ir/call-dispatch.ts`, filled once for the whole program in
  // `compiler.ts` after the shake -- replacing the four call sites in
  // `emit-bindings.ts`, `emit-callable.ts`, this file's own dead-value
  // handling below, and `class-properties/emit-class-properties.ts` that used
  // to re-derive the identical "does the callee capture nothing" test at
  // render time) are now settled in `bodyFacts` above, before `ctx` exists at
  // all: both are pure walks over `body` with no dependence on anything a
  // printer emits.
  const keyTexts = stringConstantsOf(body)
  const capturedQueryCells = new Set<DeclarationId>()
  for (const block of body.blocks.values())
    for (const operation of block.operations)
      if (operation.kind === 'allocate-callable') {
        const capture = ctx.captures.of(operation.functionId)
        if (capture.kind === 'ok') for (const slot of capture.layout.slots) capturedQueryCells.add(slot.declaration)
      }
  let entryPrologue: readonly string[] = []
  // Every per-body census, in the one order they depend on each other in --
  // `ir/facts.ts` owns that order now, and this backend supplies only the
  // questions about its own carriers plus the two storage steps that have to
  // run inside it.
  const census = irBodyCensusOf(body, {
    integerStorage: narrowedStorage,
    // A read of a plain field defers like an Array's `length` does -- see
    // `deferrableValuesOf`. Not a read of a reactive CELL: `gea_this->count`
    // spells the `Signal<double>` itself, and only the temporary it used to be
    // copied into converted it to a `double`. Inline, `(gea_this->a) ==
    // (gea_this->b)` is an ambiguous overload (`examples/apps/weather`).
    //
    // A CLASS field's reactivity is `operation.reactive`, filled at lowering
    // from the plugin's own table (`GetOperation.reactive`) -- precise per
    // read, including an INHERITED field, because lowering walked the same
    // inheritance chain `classMemberOf` always does to find which class truly
    // declares it. This used to be asked by bare key name across every
    // celled struct in the program (`[...celled.values()].flatMap(...)`),
    // which refused deferral for a plain field merely SHARING a name with
    // some unrelated class's reactive field anywhere in the program -- an
    // over-approximation now replaced by a per-operation fact.
    //
    // A RECORD element's reactivity has no plugin declaration to mark at
    // lowering (`reactiveBoundRecordFields` derives it from what JSX binds,
    // after lowering has already run), so that half asks the target's own
    // per-struct table -- exact already, since a record has no base class to
    // walk.
    //
    // But `reactive` alone is the WRONG question here, and answering it that
    // way materialized a read that had always deferred correctly. Being
    // declared reactive is not the same as HAVING a cell: a reactive field
    // whose carrier cannot be one -- an array, `records.ts`'s
    // `representationCanCell` -- gets a companion revision cell beside it and
    // is absent from `celled`, and its own read is then an ordinary field
    // load that must go on deferring. So the marker's job is to say WHICH
    // struct declares the field (the inheritance walk `celled`'s
    // declarer-keying needs and a receiver's own name cannot give), and
    // `celled` still decides whether that field is a cell.
    deferrableMemberRead: (operation) => {
      const key = keyTexts.get(operation.key.value) ?? null
      if (!isPlainMemberRead(ctx, operation, key)) return false
      if (key === null) return true
      const receiver = operation.receiver.representation
      const declaring =
        operation.reactive === true && receiver.kind === 'class-ref'
          ? (classMemberOf(classes, receiver.declaration, key)?.owner ?? null)
          : null
      const struct = declaring !== null ? cppClassName(declaring) : structNameOfReceiver(receiver)
      return struct === null || ctx.hosts.reactive.celled.get(struct)?.has(key) !== true
    },
    forwarding: {
      // Only the renderers that pass every argument through `argumentText`
      // once: a call by program body or through a `CallableObject`, and a
      // construct of a program class. A host or prototype fusion spells its
      // arguments however the host's recipe does, a tagged-union callee
      // spells them once PER ARM inside one statement, a generic set once per
      // member, and an `imul` twice.
      //
      // And only into a slot the callee's convention HAS. 10.2.1.1 binds the
      // declared formals; an argument past them is evaluated and then dropped
      // from the frame (`extra-call-arguments`), and a dropped argument's text
      // is spelled nowhere -- so a producer forwarded into that position was
      // never evaluated at all, and `mark('c')` left no mark. A rest position
      // is packed into an Array by the caller, one more spelling this audit
      // has not read, and is refused with the extras.
      forwardsCallInto: (consumer, value) => {
        const intoDeclaredFormal = (abi: CallableAbi | null): boolean => {
          if (abi === null) return false
          const index =
            consumer.kind === 'call' || consumer.kind === 'construct'
              ? consumer.arguments.findIndex((argument) => argument.value === value.value)
              : -1
          return index !== -1 && index < (abi.restFrom ?? abi.parameters.length)
        }
        switch (consumer.kind) {
          case 'call': {
            const callee = consumer.callee
            const representation = callee.representation
            const carrier = representation.kind
            const abi =
              carrier === 'function' || carrier === 'function-value-dispatch'
                ? representation.abi
                : carrier === 'function-and-constructor'
                  ? representation.call
                  : null
            return (
              intoDeclaredFormal(abi) &&
              consumer.argumentsAreSpread !== true &&
              consumer.numericRestHostCall === undefined &&
              consumer.family === undefined &&
              !ctx.numericCalls.has(consumer) &&
              !ctx.hostMemberReads.has(callee.value) &&
              !ctx.hostFunctionReads.has(callee.value) &&
              !ctx.hostClassReads.has(callee.value) &&
              !ctx.prototypeMethodReads.has(callee.value) &&
              !ctx.unionMethodReads.has(callee.value) &&
              !ctx.functionSourceReads.has(callee.value)
            )
          }
          case 'construct': {
            const representation = consumer.callee.representation
            const callee = representation.kind
            const abi =
              callee === 'constructor-family' || callee === 'constructor-value-dispatch'
                ? representation.abi
                : callee === 'function-and-constructor'
                  ? representation.construct
                  : null
            return (
              intoDeclaredFormal(abi) &&
              callee !== 'native-handle' &&
              callee !== 'dynamic' &&
              callee !== 'tagged-union' &&
              !ctx.hostClassReads.has(consumer.callee.value)
            )
          }
          // The census admits only an Array element store of the element's
          // own carrier, which `emit-properties.ts` spells once per arm.
          case 'set':
            return true
          // A cell holding exactly the value's carrier is a plain assignment;
          // anything else goes through a conversion whose spelling is its own.
          case 'binding-write': {
            const placement = ctx.placements.get(consumer.declaration)
            const held = placement?.representation
            if (!placement || !held || (placement.storage.kind !== 'local' && placement.storage.kind !== 'region')) return false
            if (ctx.hostMethodAliases.has(consumer.declaration)) return false
            return representationKey(held) === representationKey(value.representation)
          }
          // `emit-return.ts` reconciles the value against the ABI result (or
          // the promise payload an async body settles); equal carriers make
          // that reconciliation the identity.
          case 'return': {
            if (ctx.abi === null || ctx.generatorBody) return false
            const result = ctx.abi.result
            const target = result.kind === 'promise' && value.representation.kind !== 'promise' ? result.value : result
            return representationKey(target) === representationKey(value.representation)
          }
        }
      },
      // A cell of this frame that no closure shares, holding exactly what is
      // written and read, and whose value renders as C++ of its own (a host
      // member, class or namespace read has no text until its use).
      forwardsBinding: (write, read) => {
        const declaration = write.declaration
        const placement = ctx.placements.get(declaration)
        if (!placement || placement.storage.kind !== 'local' || placement.storage.owner !== ctx.owner) return false
        const held = placement.representation
        if (!held || held.kind === 'unresolved' || held.kind === 'void') return false
        const key = representationKey(held)
        if (key !== representationKey(write.value.representation) || key !== representationKey(read.result.representation)) return false
        // A captured cell is read by the closure that copies it at allocation,
        // which no `binding-read` of this body records.
        if (ctx.captures.isBoxed(declaration) || ctx.captures.isCaptured(declaration)) return false
        if (ctx.hostMethodAliases.has(declaration) || ctx.reactiveBindingOrigins.has(declaration)) return false
        const value = write.value.value
        return (
          !ctx.hostMemberReads.has(value) &&
          !ctx.hostClassReads.has(value) &&
          !ctx.hostFunctionReads.has(value) &&
          !ctx.hostNamespaceReads.has(value) &&
          !ctx.prototypeMethodReads.has(value)
        )
      }
    },
    deadValues: {
      pureGet: (operation, key) => isPlainMemberRead(ctx, operation, key),
      // The exact producers `emit-callable.ts` (`admission.kind === 'none'`) and
      // `emit-bindings.ts` (`directCallableBindings`) register as direct callees.
      directCallee: (producer) =>
        producer.kind === 'allocate-callable'
          ? ctx.captures.of(producer.functionId).kind === 'none'
          : producer.kind === 'binding-read'
            ? ctx.directCallableBindings.has(producer.declaration)
            : producer.kind === 'get' && directClassMethodBody(ctx, producer, keyTexts.get(producer.key.value) ?? null) !== null,
      // A named construct entry still reads the constructor's per-evaluation
      // prototype owner. Devirtualizing the code pointer cannot discard that
      // carrier, even for a class whose methods capture nothing.
      directConstructor: () => false,
      // A construction is deletable when the class it builds is one nothing can
      // observe being built. Keyed off the RESULT, which is the only operand of a
      // `construct` that names the class: the callee is the constructor object,
      // whose carrier is the constructor's convention rather than the instance's.
      pureConstruct: (operation) => {
        const result = operation.result.representation
        return result.kind === 'class-ref' && ctx.instantiation.unobservableConstructions.has(result.declaration)
      },
      // Only for a callee reached BY NAME. An indirect call names no body, so
      // there is no body to ask -- and a thunk's frame declares the receiver
      // whatever the target does with it.
      ignoresReceiver: (callee) =>
        callee !== undefined &&
        callee.kind === 'allocate-callable' &&
        ctx.captures.of(callee.functionId).kind === 'none' &&
        ctx.instantiation.receiverIgnoringFunctions.has(callee.functionId)
    },
    stringQueryCell: (declaration) => {
      const placement = ctx.placements.get(declaration)
      return (
        placement?.storage.kind === 'local' &&
        placement.storage.owner === body.sourceOwner &&
        placement.representation?.kind === 'string' &&
        !ctx.captures.isBoxed(declaration) &&
        !capturedQueryCells.has(declaration)
      )
    },
    spellConstants: () => spellConstants(ctx, body),
    formalStorage: (settled) => {
      // The collectors below read these off the context, so they are published
      // first -- and the deferral set they see is deliberately the one the
      // hoists have not yet claimed from.
      //
      // Sixteen of these seventeen write through `prepass`, not `ctx`, because
      // `ctx`'s own view of the same field is `ReadonlyMap`/`ReadonlySet` --
      // see `EmitBodyPrepassFacts`'s doc. `ctx.deferrable` is the one
      // exception still written here directly: it has a genuine render-time
      // write of its own (`emit-arrays.ts`'s `materializeDenseReference`), so
      // it stays a plain mutable `Set` rather than joining its siblings.
      for (const value of settled.localIterators) prepass.localIterators.add(value)
      for (const value of settled.dead) prepass.deadValues.add(value)
      for (const value of settled.unread) prepass.unreadValues.add(value)
      for (const [value, known] of settled.booleanConstants) prepass.booleanConstants.set(value, known)
      for (const value of settled.deferrable) prepass.deferrable.add(value)
      for (const value of settled.callArgumentOnly) prepass.callArgumentOnly.add(value)
      for (const value of settled.typeQueryValues) prepass.typeQueryValues.add(value)
      for (const binding of settled.typeQueryBindings) prepass.typeQueryBindings.add(binding)
      for (const [operation, comparison] of settled.typeQueryComparisons) prepass.typeQueryComparisons.set(operation, comparison)
      for (const value of settled.integerValues) prepass.integerValues.add(value)
      for (const declaration of settled.integerBindings) prepass.integerBindings.add(declaration)
      for (const [value, form] of settled.remainderForms) prepass.remainderForms.set(value, form)
      for (const [call, intrinsic] of settled.numericCalls) prepass.numericCalls.set(call, intrinsic)
      for (const value of settled.numericCallOnly) prepass.numericCallOnly.add(value)
      collectFormalCells(ctx, prepass, body)
      // A captured cell initialized on separate branches has no single first
      // write that dominates the closure allocation. Allocate its handle at entry
      // so each branch only assigns the pointee. Kept separate from declarations:
      // declarations must remain uninitialized so gotos may cross their scope.
      entryPrologue = earlyCapturedCellPrologue(ctx, body)
      collectCapacityHints(ctx, prepass, body)
      return new Set(ctx.formalCells.keys())
    }
  })
  for (const value of census.loopInvariantValues) prepass.loopInvariantValues.add(value)
  for (const [value, layout] of census.sharedStringLayouts) prepass.sharedStringLayouts.set(value, layout)
  for (const value of census.hoistedResults) prepass.hoistedResults.add(value)
  for (const [declaration, forwarded] of census.forwardedBindings) prepass.forwardedBindings.set(declaration, forwarded)
  for (const [value, prior] of census.reusedStringLengths) prepass.reusedStringLengths.set(value, prior)
  // The hoists and the length reuse each claim a value out of the deferral set
  // after the storage step above took its copy, so drop what they claimed.
  for (const value of prepass.deferrable) if (!census.deferrable.has(value)) prepass.deferrable.delete(value)
  const hoists = census.hoists
  collectDirectBindingSinks(prepass, body, hoists.relocated)
  // After the hoists, because a window's own bound is often the loop-invariant
  // read they relocate, and a relocated value is one this may name.
  admitDenseWindows(ctx, prepass, body)
  const isSingleBlock = body.blockOrder.length === 1
  const orderLabels = isSingleBlock ? new Map<IrBlockId, string>() : blockLabelsOf(body.blockOrder)
  const owner = sectionOwnerOf(body)

  // A merge is one variable written on each incoming path, so its name has to
  // exist before any predecessor renders -- including a predecessor that comes
  // earlier in the block order than the merge itself. Minting every merge's
  // name up front is what makes that hold without depending on block order.
  const mergeWrites = mergeWritesOf(ctx, body, (result) => defineValue(ctx, result))
  // After the merges, because a block that writes one is not empty.
  const flow = threadedFlowOf(ctx, body, orderLabels, hoists, mergeWrites)
  const labels = flow.labels

  // A try region's blocks are rendered together, as one `try { } catch (...)
  // { }` chunk, by `renderTryRegion` -- never one at a time by the loop below.
  // `consumedByRegion` is filled in as each region is rendered, so the loop
  // can skip every block a region already accounted for.
  const regionByTryEntry = new Map<IrBlockId, IrTryRegion>(body.tryRegions.map((region) => [region.tryEntry, region]))
  const iteratorCloseRegionByEntry = new Map<IrBlockId, IrIteratorCloseRegion>(
    (body.iteratorCloseRegions ?? []).map((region) => [region.entry, region])
  )
  const consumedByRegion = new Set<IrBlockId>()

  const lineageOf = (blockIds: readonly IrBlockId[]) => {
    for (const id of blockIds) {
      const block = body.blocks.get(id)
      if (!block) continue
      const found = allOperationsOf(block).find((operation) => operation.lineage !== null)
      if (found) return found.lineage
    }
    return null
  }

  const blocks: CppArtifact[] = []
  // Invariant 5's seal (`emit-context.ts`'s `sealFactFieldsForRender`): from
  // here to the end of the loop every operation renders against a context
  // whose facts are settled. Inert unless `GEA_SEAL_EMIT_CONTEXT` is set.
  const unseal = sealFactFieldsForRender(ctx)
  try {
    for (const blockId of body.blockOrder) {
      if (consumedByRegion.has(blockId)) continue
      const block = body.blocks.get(blockId)
      if (!block) throw new Error(`ir body ${body.owner} lists block ${blockId} in blockOrder but has no matching block`)

      // Shared by both region renderers below, and by each other's nested
      // calls: `renderTryRegion`'s `preparePart` recognizes an iterator-close
      // region nested inside a try part through `iteratorCloseRegionByEntry`/
      // `renderIteratorCloseRegion`, the reverse of the more common nesting
      // `renderIteratorCloseRegion` itself already handled through `regionByTryEntry`.
      const regionRendering: RegionRendering = {
        emitOperation,
        emitTerminator,
        labelOf: requireBlockLabel,
        labels,
        isSingleBlock,
        mergeWrites,
        regionByTryEntry,
        iteratorCloseRegionByEntry,
        renderIteratorCloseRegion,
        // The hoist plan and the block tail, so a region's blocks render the
        // way every other block does -- see `RegionRendering` for what was
        // being dropped, and why one of the three was a defect rather than a
        // missed optimization.
        relocated: hoists.relocated,
        emitHoistedInto: (partCtx, partLines, partBlock) => {
          for (const operation of hoists.into.get(partBlock) ?? []) emitOperation(partCtx, partLines, operation)
        },
        emitBlockTail: (partCtx, partLines, partBlock) => {
          emitDenseSetup(partCtx, partLines, partBlock)
          const partFill = partCtx.fillLoops.get(partBlock)
          if (!partFill) return false
          emitFillLoop(partCtx, partLines, partFill, requireBlockLabel(labels, partFill.exit))
          return true
        }
      }

      const iteratorCloseRegion = iteratorCloseRegionByEntry.get(blockId)
      if (iteratorCloseRegion) {
        const lines: string[] = []
        const consumed = renderIteratorCloseRegion(ctx, lines, body, iteratorCloseRegion, regionRendering)
        for (const id of consumed) consumedByRegion.add(id)
        blocks.push({
          text: lines.join('\n'),
          facts: { kind: 'materialized', representation: { kind: 'void' }, owner, lineage: iteratorCloseRegion.lineage }
        })
        continue
      }

      const region = regionByTryEntry.get(blockId)
      if (region) {
        const lines: string[] = []
        const consumed = renderTryRegion(ctx, lines, body, region, regionRendering)
        for (const id of consumed) consumedByRegion.add(id)
        blocks.push({
          text: lines.join('\n'),
          facts: { kind: 'materialized', representation: { kind: 'void' }, owner, lineage: lineageOf(consumed) }
        })
        continue
      }

      if (flow.skipped.has(blockId)) continue
      const lines: string[] = []
      if (!isSingleBlock && flow.labeled.has(requireBlockLabel(labels, blockId))) lines.push(`${requireBlockLabel(labels, blockId)}:`)
      for (const operation of block.operations) {
        const result = 'result' in operation ? operation.result : null
        if (result && hoists.relocated.has(result.id)) continue
        emitOperation(ctx, lines, operation)
      }
      // AFTER the block's own statements: a preheader assigns the cells a hoisted read names.
      for (const operation of hoists.into.get(blockId) ?? []) emitOperation(ctx, lines, operation)
      // The writes belong after everything this block computed and before it
      // transfers control: that is exactly where the incoming value is live.
      for (const write of mergeWrites.get(blockId) ?? []) {
        const raw = operandText(ctx, write.value)
        const converted = alignedValueText(ctx, 'emit.ts:2111', write.value.representation, write.target, raw)
        if (converted === null) {
          throw createCppEmitBlockedError(
            `conversion:${representationKey(write.value.representation)}->${representationKey(write.target)}`,
            `cannot convert merge input from "${representationKey(write.value.representation)}" to "${representationKey(write.target)}"`
          )
        }
        lines.push(`${write.name} = ${converted};`)
      }
      // Last of all, so every value a window's condition names -- a hoisted read,
      // a merge -- is already assigned in this block.
      emitDenseSetup(ctx, lines, blockId)
      // A counted `push` loop's header does not branch: it appends (`emit-arrays.ts`).
      const fill = ctx.fillLoops.get(blockId)
      if (fill) emitFillLoop(ctx, lines, fill, requireBlockLabel(labels, fill.exit))
      else emitTerminator(ctx, lines, labels, isSingleBlock, block.terminator, flow.nextLabel.get(blockId) ?? null)

      blocks.push({
        text: lines.join('\n'),
        facts: {
          kind: 'materialized',
          // A block is a sequence of statements, not a value: `void` is the one
          // carrier that says exactly that instead of borrowing some operand's
          // representation to stand in for a whole statement sequence.
          representation: { kind: 'void' },
          owner,
          // The block's authority is the first operation in it that has any: a
          // terminator is frequently synthesized and carries none, and a section
          // attributed to nothing when it does contain real work would lose the
          // trace back to the source that produced it.
          lineage: allOperationsOf(block).find((operation) => operation.lineage !== null)?.lineage ?? null
        }
      })
    }
  } finally {
    unseal()
  }

  // Every dispatched method reference has to have been CALLED. One that was
  // stored, passed or returned instead is carried as a `CallableObject` over a
  // single statically named body, which for an overridden method is the base's
  // -- the exact silent miscompile the dispatch exists to remove. Asked here,
  // once the whole body has rendered, because only then is it known that no
  // call consumed it.
  const carried = [...ctx.virtualCallees.keys()].filter((value) => !ctx.virtualCalleesUsed.has(value))
  if (carried.length > 0) {
    throw createCppEmitBlockedError(
      'call-abi:virtual-dispatch',
      `takes a function object of an overridden method rather than calling it (${carried.map((value) => ctx.virtualCallees.get(value)?.member ?? value).join(', ')}); a carrier names one body, which for an overridden method is the base's`
    )
  }
  const carriedUnionMethods = [...ctx.unionMethodReads.keys()].filter((value) => !ctx.unionMethodReadsUsed.has(value))
  if (carriedUnionMethods.length > 0) {
    throw createCppEmitBlockedError(
      'call-abi:tagged-union-method',
      `takes ${carriedUnionMethods.length} tagged-union method value(s) without calling them; each union arm has its own receiver convention, so no single callable carrier can preserve them`
    )
  }
  // Declarations come last because they are only complete once every block has
  // rendered, and first in the output because a `goto` may not jump into the
  // scope of a variable whose declaration initializes it.
  const declarationFacts: CppFacts = { kind: 'materialized', representation: { kind: 'void' }, owner, lineage: null }
  const declarations: CppArtifact = {
    text: ctx.declarations.map((entry) => `${entry.type} ${entry.name};`).join('\n'),
    facts: declarationFacts
  }
  const prologue: CppArtifact[] = entryPrologue.length === 0 ? [] : [{ text: entryPrologue.join('\n'), facts: declarationFacts }]
  return [declarations, ...prologue, ...blocks]
}

// Re-exported so a consumer that emits bodies has one import for the naming
// rules those bodies are rendered under; the definitions live with the context
// they name.
export {
  cppConstructedThunkName,
  cppConstructThunkName,
  cppFormalName,
  cppReceiverName,
  cppThunkName,
  isCppEmitBlockedError
} from './emit-context.js'
