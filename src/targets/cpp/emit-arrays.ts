import { regexpRoleOf } from './prototype/emit-prototype-regexp.js'
import { boxedValueText } from './emit-dynamic-properties.js'
import type { DeclarationId, IrValueId } from '../../identity/ids.js'
import type { AllocateArrayObjectOperation, CallOperation, ComputeOperation, IrBlockId, IrBody, IrOperand } from '../../ir/model.js'
import {
  collectDefinitionSites,
  controlFlowGraphOf,
  dominatorTreeOf,
  isVisible,
  naturalLoopsOf,
  type DefinitionSite,
  type NaturalLoop
} from '../../ir/dominance.js'
import { operandsOfIrOperation, resultOfIrOperation } from '../../ir/queries.js'
import { containsUnresolved, representationKey, type RecordField, type Representation } from '../../representation/model.js'
import { admittedDenseLoopPlanOf, denseLoopsOf, type DenseArray, type DenseReference } from '../../ir/dense-loops.js'
import {
  bindingReference,
  cppDenseDivisorName,
  cppDenseFlagName,
  cppDenseLengthName,
  cppDensePointerName,
  cppDenseRowName,
  createCppEmitBlockedError,
  defineValue,
  operandText,
  type CapacitySource,
  type EmitContext,
  type FillLoop,
  storageTypeOf,
  type EmitBodyPrepassFacts
} from './emit-context.js'
import { readsCell } from './deferral-safety.js'
import { cellValueText } from './emit-bindings.js'
import { alignedText } from './emit-callable.js'
import { cppConstantLiteral, cppNarrowedIntegerType, cppGlobalName, cppRecordFieldName, cppTypeOf, cppScalarType } from './types.js'
import { alignedValueText, narrowedLoadText, widenedStoreText } from './emit-narrowing.js'
import { arrayBulkAppendMethodName } from './prototype/emit-prototype-array.js'

/**
 * How many constant elements make a static table the better spelling.
 *
 * Every element of a literal renders as its own `push` statement, so a mesh
 * table of 87,210 doubles is 87,210 statements in one function body. Clang's
 * per-function passes are superlinear in statement count: `ios-metal-world-game`
 * carries four such tables -- 252,342 elements between them -- in a single
 * module body, which unrolled was 98% of a 256,880 line translation unit and
 * did not finish compiling in 105 minutes at 35.7 GB resident.
 *
 * Below a handful the individual stores are worth keeping: they fold, they
 * inline, and three of them read as what the source says. Past that nothing
 * folds and the statements are pure cost -- a twelve-entry month table
 * rebuilt on every call was twelve capacity checks and up to four
 * reallocations (`examples/apps/weather`), where the table is one `reserve`
 * and one copy out of `.rodata`. So the table starts where a literal stops
 * being a handful, not at the size where the statement form stops compiling.
 */
const constantTableThreshold = 8

/** How many values one line of a static table's initializer carries. A table of 87,210 doubles is otherwise a single 700 KB line. */
const constantTableRowWidth = 16

/**
 * The element spellings a static table may hold.
 *
 * Trivially copyable scalars only -- their initializer is a plain literal list
 * and their table is `.rodata`. A `Ref` or a `std::string` element would need a
 * dynamic initializer, which is the cost this avoids rather than one it should
 * pay somewhere else.
 */
const constantTableElements: ReadonlySet<string> = new Set(['double', 'long long', 'bool'])

/** How deep a folded constant expression may nest before this stops proving it. `-x` over a literal is one level; nothing real needs many. */
const constantExpressionDepth = 4

/**
 * Whether a value's rendered text is a constant expression a `static const` initializer may hold.
 *
 * `deferredTexts` is the gate in every case: a value that was NOT folded is
 * spelled as a local's name, and a name is not an initializer. Past that gate a
 * `constant` operation qualifies outright, and a unary `-`/`+` qualifies when
 * what it negates does -- which is how a source `-0.35792` reaches here.
 */
const isConstantExpression = (ctx: EmitContext, value: IrValueId, depth: number): boolean => {
  if (!ctx.deferredTexts.has(value)) return false
  if (ctx.constantTexts.has(value)) return true
  if (depth >= constantExpressionDepth) return false
  const origin = ctx.computeOrigins.get(value)
  if (origin === undefined || origin.form !== 'unary') return false
  if (origin.operator !== '-' && origin.operator !== '+') return false
  if (origin.operands.length !== 1) return false
  const operand = origin.operands[0]
  if (operand === undefined) return false
  return isConstantExpression(ctx, operand.value, depth + 1)
}

/**
 * One array literal whose every element is a folded constant, as a static table.
 *
 * The predicate is the emitter's own records rather than the shape of the
 * rendered text: `deferredTexts` says the value's text is spelled inline rather
 * than as the name of a local, and `constantTexts` says it came from a
 * `constant` operation. Both together are what make the push read
 * `v117974->push((1.5))`, and they are what makes the same text legal inside a
 * `static const` initializer.
 *
 * A source `-0.00981` is NOT a constant operation: it is unary minus over one,
 * and it renders `(-(0.00981))`. Two of every five elements of
 * `ios-metal-world-game`'s vertex tables are that shape, and reading only
 * `constantTexts` refused all four tables on their account. So a folded unary
 * `-`/`+` over a constant expression is itself one, which `computeOrigins`
 * answers without any new bookkeeping.
 *
 * A literal with a hole or a spread is not a table -- a hole is observably not
 * an element -- and neither is one whose elements are computed at run time, so
 * both keep the statement form.
 */
const constantTableOf = (
  ctx: EmitContext,
  operation: AllocateArrayObjectOperation,
  elementRepresentation: Representation,
  element: string,
  name: string
): { readonly name: string; readonly rows: readonly string[]; readonly count: number } | null => {
  if (operation.elements.length < constantTableThreshold) return null
  if (!constantTableElements.has(element)) return null
  const texts: string[] = []
  for (const slot of operation.elements) {
    if (slot.kind !== 'element') return null
    if (!isConstantExpression(ctx, slot.value.value, 0)) return null
    texts.push(alignedText(ctx, elementRepresentation, slot.value, 'allocate-array-object'))
  }
  const rows: string[] = []
  for (let at = 0; at < texts.length; at += constantTableRowWidth) {
    rows.push(`${texts.slice(at, at + constantTableRowWidth).join(', ')},`)
  }
  return { name: `gea_table_${name}`, rows, count: texts.length }
}

/**
 * An Array exotic object with its elements installed.
 *
 * A hole is pushed as a hole, not as a default-constructed element: the two are
 * observably different (`0 in a`, enumeration, `length`), and this is the one
 * place the distinction the IR carries could be silently dropped.
 */
/**
 * One element of a WITHHELD array literal -- the only place this backend emits
 * a braced-init-list of computed values (`gea::arrayOf<T>({a, b})`).
 *
 * Inside braces C++ applies the narrowing rules ([dcl.init.list]/7), which are
 * strictly stronger than the ordinary implicit conversions every other
 * argument position allows: `long long` to `double` is a perfectly good
 * conversion as a function argument and a hard error as a list element,
 * because the source type cannot be proven to round-trip. `alignedText` is
 * right for both positions and cannot tell them apart -- it asks whether a
 * conversion EXISTS, and this one does.
 *
 * So the cast is added here, at the one site the stronger rule applies, and
 * only between two arithmetic scalars: `static_cast` is the explicit spelling
 * of the identical conversion, which is exactly what [dcl.init.list] accepts.
 *
 * Measured on `examples/bouncing-balls`: `Math.max(BALL_R * 2 + 1,
 * Math.floor(window.innerWidth()))` packs an integer-carrier `long long`
 * beside a `double`, and clang rejected both sites with
 * `-Wc++11-narrowing` on a program that certified, lowered and emitted
 * cleanly.
 *
 * `bigint` is excluded on both sides: `gea::BigInt` is a class type, and a
 * `static_cast` to or from it is not the arithmetic conversion this rule is
 * about. Such a pair keeps `alignedText`'s answer, and if that answer is
 * wrong the refusal it raises names it.
 */
const packElementText = (ctx: EmitContext, element: Representation, elementType: string, value: IrOperand): string => {
  const text = alignedText(ctx, element, value, 'allocate-array-object')
  const held = value.representation
  if (element.kind !== 'scalar' || held.kind !== 'scalar') return text
  if (element.domain === 'bigint' || held.domain === 'bigint') return text
  // The STORAGE, not the carrier: a value the integer census narrowed is held
  // in a `long long` while its carrier still says `scalar(number)`, so asking
  // the carrier answers `double` for a variable that is not one -- and the
  // cast this rule exists to add is exactly the one that gets skipped.
  // `examples/bouncing-balls` and `examples/gea3d-cube` both emitted a
  // `long long` into a `{...}` of `double` and were rejected for it.
  if (storageTypeOf(ctx, value.value, held) === elementType) return text
  return `static_cast<${elementType}>(${text})`
}

export const emitAllocateArrayObject = (ctx: EmitContext, lines: string[], operation: AllocateArrayObjectOperation): void => {
  const representation = operation.result.representation
  // `reason` records only WHY the destination cell is `dynamic` (an opt-in
  // fallback literal, a rest binding of a declared `any` never narrowed, ...);
  // it names no separate runtime representation, so the allocation below --
  // build a native `ArrayObject<gea::Value>`, fill it, box the result --  is
  // the correct emission for every one of them alike. Gating on one specific
  // reason left `const [a, ...rest] = anyIterable` (`ir/lower-destructuring.ts`'s
  // `lowerArrayPatternRest`) refusing to reach an allocation this exact branch
  // already performs for the sibling literal `[...anyIterable]`.
  if (representation.kind === 'dynamic') {
    const name = defineValue(ctx, operation.result)
    const array = `${name}_array`
    lines.push(`${name} = [&]() { auto ${array} = gea::makeRef<gea::ArrayObject<gea::Value>>();`)
    for (const slot of operation.elements) {
      if (slot.kind === 'element') lines.push(`${array}->push(${boxedValueText(ctx, slot.value, 'a fallback array element')});`)
      else if (slot.kind === 'hole') lines.push(`${array}->pushHole();`)
      else if (slot.kind === 'gather') lines.push(`gea::runtime::iterator::appendGather(*${array}, ${operandText(ctx, slot.iterator)});`)
      else
        throw createCppEmitBlockedError(
          'runtime-helper:allocation:array-literal:dynamic(spread)',
          'fallback array spread needs dynamic iteration'
        )
    }
    lines.push(`return gea::Value::box(gea::Value::Tag::Object, ${array}); }();`)
    return
  }
  if (representation.kind !== 'array-object') {
    throw createCppEmitBlockedError(
      `runtime-helper:allocation:array-literal:${representation.kind}`,
      `carries a "${representation.kind}" result, but an array literal must allocate an "array-object" carrier`
    )
  }
  if (representation.ownership !== 'shared-refcount') {
    throw createCppEmitBlockedError(
      `runtime-helper:allocation:array-literal:array-object(${representation.ownership})`,
      `an array allocation carries ownership "${representation.ownership}", but this emitter only spells std::make_shared for "shared-refcount"`
    )
  }
  const element = cppTypeOf(representation.element)
  // A literal made entirely of ordinary elements whose one use is an
  // expression away is withheld whole rather than built into a temporary --
  // see `EmitContext.pendingPacks`. A hole or a spread is not a value an
  // initializer list can carry, so a literal containing either keeps the
  // statement form below; a hole in particular is observably not an element
  // and could not survive the crossing.
  const ordinary = operation.elements.flatMap((slot) => (slot.kind === 'element' ? [slot.value] : []))
  if (!representation.recursive && ctx.callArgumentOnly.has(operation.result.id) && ordinary.length === operation.elements.length) {
    const elements = ordinary.map((value) => packElementText(ctx, representation.element, element, value))
    ctx.pendingPacks.set(operation.result.id, { elements, elementType: element })
    return
  }
  const name = defineValue(ctx, operation.result)
  // A recursive list owns the named wrapper, not its ArrayObject base. The
  // wrapper is intentionally skipped by the braced pack fast path above too:
  // `arrayOf<E>` returns the base `Ref<ArrayObject<E>>`, while the source
  // value's identity is `Ref<wrapper>`.
  lines.push(`${name} = gea::makeRef<${cppTypeOf(representation, 'owned')}>();`)
  // The capacity this array's fill loop already states -- see
  // `collectCapacityHints`. It renders here, at the allocation, because that
  // is the one point every path to the loop passes through.
  const capacity = ctx.capacityHints.get(operation.result.id)
  if (capacity !== undefined) {
    const count =
      capacity.kind === 'literal'
        ? capacity.text
        : capacity.kind === 'value'
          ? operandText(ctx, capacity.operand)
          : cellValueText(bindingReference(ctx, capacity.declaration, 'an array capacity hint'))
    lines.push(`gea::reserveHint(${name}, ${count});`)
  }
  const table = constantTableOf(ctx, operation, representation.element, element, name)
  if (table !== null) {
    lines.push(`static const ${element} ${table.name}[] = {`)
    for (const row of table.rows) lines.push(`  ${row}`)
    lines.push('};')
    lines.push(`gea::runtime::array::appendTable(${name}, ${table.name}, ${table.count});`)
    return
  }
  for (const slot of operation.elements) {
    if (slot.kind === 'hole') {
      lines.push(`${name}->pushHole();`)
      continue
    }
    if (slot.kind === 'spread') {
      // `ir/lower-allocation.ts` already proved the source is one of the three
      // natively-iterable shapes and that the elements its range copy produces
      // share this literal's exact element carrier -- these are fail-closed
      // re-checks, not a first opinion, kept for the same reason
      // `lowerTupleLiteral`'s arity assertion is kept: a future widening of
      // that lowering that forgot the match would otherwise emit an ill-formed
      // range copy silently.
      const spread = slot.value.representation
      // A `Set<T>` (ECMA-262 24.2.3.10) and a `string` (22.1.3.36) each drain
      // to completion into the same destination, through their own bulk
      // appends. Neither takes a `from`: only an Array source has a rest
      // element's "everything past position N" shape, and `lower-allocation.ts`
      // never mints a non-zero `from` for the other two.
      if (spread.kind === 'keyed-collection' && spread.family === 'set') {
        if (representationKey(spread.key) !== representationKey(representation.element) || slot.from !== 0) {
          throw createCppEmitBlockedError(
            `conversion:${representationKey(spread.key)}->${representationKey(representation.element)}`,
            `a Set spread element's own key carrier does not match this array's "${representationKey(representation.element)}" element carrier`
          )
        }
        lines.push(`gea::appendSetRange(*${name}, *${operandText(ctx, slot.value)});`)
        continue
      }
      // A `Map` spreads as one freshly built `[K, V]` pair per entry (ECMA-262
      // 24.1.5.1), so the destination's element carrier must be that pair's
      // record -- checked here by field key and by the collection's own key and
      // value carriers, the same three facts `publish.ts`'s
      // `mapPairCursorElementOf` checks before publishing the cursor.
      if (spread.kind === 'keyed-collection' && spread.family === 'map') {
        const pair = representation.element.kind === 'record' ? representation.element : null
        const first = pair?.fields[0]
        const second = pair?.fields[1]
        const matches =
          pair !== null &&
          pair.fields.length === 2 &&
          first?.key === '0' &&
          second?.key === '1' &&
          spread.value !== null &&
          representationKey(first.value) === representationKey(spread.key) &&
          representationKey(second.value) === representationKey(spread.value) &&
          slot.from === 0
        if (!matches) {
          throw createCppEmitBlockedError(
            `conversion:map-pair->${representationKey(representation.element)}`,
            `a Map spread element yields "[K, V]" pairs, which this array's "${representationKey(representation.element)}" element carrier cannot hold`
          )
        }
        lines.push(`gea::appendMapRange(*${name}, *${operandText(ctx, slot.value)});`)
        continue
      }
      // A `RegExpExecArray`'s capture slots (ECMA-262 22.2.7.2): a String or
      // `undefined` in each, so the destination's element has to be the
      // optional string -- `publish.ts`'s `patternSourceSnapshotOf` is the
      // one thing that publishes this pairing, and this is its re-check.
      if (regexpRoleOf(spread) === 'exec-result') {
        const element = representation.element
        if (element.kind !== 'optional' || element.payload.kind !== 'string' || slot.from !== 0) {
          throw createCppEmitBlockedError(
            `conversion:regexp-exec-capture->${representationKey(element)}`,
            `a RegExpExecArray spread yields a string or \`undefined\` per capture slot, which this array's "${representationKey(element)}" element carrier cannot hold`
          )
        }
        lines.push(`gea::runtime::regex::appendCaptureRange(*${name}, *${operandText(ctx, slot.value)});`)
        continue
      }
      if (spread.kind === 'string') {
        if (representation.element.kind !== 'string' || slot.from !== 0) {
          throw createCppEmitBlockedError(
            `conversion:code-point->${representationKey(representation.element)}`,
            `a string spread element yields code points, which this array's "${representationKey(representation.element)}" element carrier cannot hold`
          )
        }
        lines.push(`gea::appendCodePointRange(*${name}, ${operandText(ctx, slot.value)});`)
        continue
      }
      // A cursor source -- a `Generator<T, ...>` carried as `iterator(T)`
      // (`representation/derive.ts`) -- is drained by pulling its own steps.
      // `[...g]` runs the coroutine to completion, which is exactly ECMA-262
      // 13.2.4.2 ArrayAccumulation for a SpreadElement: there is no `break`
      // inside a spread, so a generator that never completes never returns
      // here, the same way it never returns in node.
      if (spread.kind === 'iterator') {
        if (representationKey(spread.element) !== representationKey(representation.element) || slot.from !== 0) {
          throw createCppEmitBlockedError(
            `conversion:${representationKey(spread.element)}->${representationKey(representation.element)}`,
            `a cursor spread element yields "${representationKey(spread.element)}", which this array's "${representationKey(representation.element)}" element carrier cannot hold`
          )
        }
        lines.push(`gea::appendIteratorRange(*${name}, ${operandText(ctx, slot.value)});`)
        continue
      }
      if (spread.kind !== 'array-object') {
        throw createCppEmitBlockedError(
          `conversion:${representationKey(spread)}->${representationKey(representation.element)}`,
          `a spread element's own carrier does not match this array's "${representationKey(representation.element)}" element carrier`
        )
      }
      if (representationKey(spread.element) !== representationKey(representation.element)) {
        // Admitted by the lowering (`slot.element`, see `IrArrayElement`) and
        // converted per element with the same recipes a single stored value
        // uses; a pair no recipe covers refuses here, by name.
        const converted =
          slot.element !== undefined && representationKey(slot.element) === representationKey(representation.element)
            ? alignedValueText(ctx, 'emit-arrays.ts:364', spread.element, representation.element, 'gea_element')
            : null
        if (converted === null) {
          throw createCppEmitBlockedError(
            `conversion:${representationKey(spread.element)}->${representationKey(representation.element)}`,
            `a spread element's own "${representationKey(spread.element)}" carrier has no per-element conversion into this array's "${representationKey(representation.element)}" element carrier`
          )
        }
        lines.push(
          `${name}->appendRangeConverted(*${operandText(ctx, slot.value)}, ${slot.from}, [&](const ${cppTypeOf(spread.element)}& gea_element) { return ${converted}; });`
        )
        continue
      }
      lines.push(`${name}->appendRange(*${operandText(ctx, slot.value)}, ${slot.from});`)
      continue
    }
    if (slot.kind === 'gather') {
      if (representation.element.kind !== 'dynamic' || slot.iterator.representation.kind !== 'dynamic') {
        throw createCppEmitBlockedError(
          `runtime-helper:allocation:array-literal:${representation.element.kind}(dynamic-gather)`,
          'a generic iterator gather requires a dynamic iterator record and an array with dynamic elements'
        )
      }
      lines.push(`gea::runtime::iterator::appendGather(*${name}, ${operandText(ctx, slot.iterator)});`)
      continue
    }
    // An element whose own carrier is not the array's is reconciled on the way
    // in, by the same rule an argument written into a parameter slot is --
    // conversion where one is installed, and nothing at all where the target
    // performs it implicitly (an `NSBox` pushed into an array of `NSView`).
    //
    // `const retained: unknown[] = []` is why this is not simply a store: the
    // program itself declared the element `unknown`, so the array holds the box
    // and a concrete value has to be boxed on the way in. Without it the push
    // assigned an `NSObject` straight into a `gea::Value` slot, which is the
    // one thing the box's storage-only design cannot do implicitly.
    lines.push(`${name}->push(${alignedText(ctx, representation.element, slot.value, 'allocate-array-object')});`)
  }
}

/**
 * Which arrays a loop fills, and how many elements that loop will push.
 *
 * `const data: number[] = []` followed by `for (let i = 0; i < n; i++)
 * data.push(i)` grows the vector from empty: about `log2(n)` reallocations,
 * each copying everything written so far, so filling N elements moves ~2N of
 * them. The hand-written baselines this is measured against all open with
 * `reserve(n)` -- `array_read.cpp` is literally `data.reserve(it)` -- and the
 * previous implementation measured the same fill loop at 97 ms without the
 * hint and 38.7 ms with it, against a native 36.7 ms. It was the single
 * largest gap on the array fixtures and it is not a code-generation
 * difference; it is a capacity the program states and the emitter was
 * throwing away.
 *
 * A capacity is a HINT and nothing else: reserving too much wastes memory
 * until the array grows into it, reserving too little costs a reallocation,
 * and reserving the wrong amount can never change what the program computes.
 * That is what makes an approximate loop-trip count -- the test's bound, with
 * no attempt to prove the step, the start, or the absence of a `break` -- a
 * sound thing to read. `reserveHint` in the runtime header caps what it will
 * act on, so a loop bound that turns out to be enormous costs nothing rather
 * than a huge allocation.
 *
 * What must be exact is the two facts the hint is keyed by: the array is
 * allocated OUTSIDE the loop (so the pushes accumulate into one array rather
 * than into a fresh one per iteration), and the bound is computed outside it
 * (so it is a single count rather than something that changes per iteration).
 * Both are read off the dominator tree, and the bound is additionally required
 * to be visible where the allocation renders -- an allocation that precedes
 * its own bound cannot name it.
 */
export const collectCapacityHints = (ctx: EmitContext, prepass: EmitBodyPrepassFacts, body: IrBody): void => {
  const graph = controlFlowGraphOf(body)
  const dominance = dominatorTreeOf(body)
  const sites = collectDefinitionSites(body)

  const constants = new Map<IrValueId, string>()
  const numericConstants = new Map<IrValueId, string>()
  const computes = new Map<IrValueId, ComputeOperation>()
  const allocations = new Map<IrValueId, DefinitionSite>()
  // A value the IR reads out of a binding cell, and every write into one.
  //
  // Neither the array nor the bound arrives as a plain SSA value in ordinary
  // source: `const data = []` stores into a cell and every `data.push(...)`
  // reads it back, so the receiver at the push site is a fresh `binding-read`
  // produced INSIDE the loop, and so is the `iterations` the test compares
  // against. Judging either by its own definition site would answer "defined
  // in the loop" for both and refuse every real fill loop. The question that
  // actually matters is about the CELL: which array it holds, and whether the
  // loop can change it.
  const bindingReads = new Map<IrValueId, DeclarationId>()
  const bindingWrites = new Map<DeclarationId, { readonly site: DefinitionSite; readonly value: IrOperand }[]>()
  // Where each value is defined and where it is read -- what a fill loop needs
  // to know that nothing it computes outlives the turns it is about to skip.
  const definitionBlocks = new Map<IrValueId, IrBlockId>()
  const literals = new Map<IrValueId, string>()
  const pushLookups = new Map<IrValueId, IrOperand>()
  const arrayPacks = new Map<IrValueId, AllocateArrayObjectOperation>()
  const useBlocks = new Map<IrValueId, Set<IrBlockId>>()
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of [...block.operations, block.terminator]) {
      for (const operand of operandsOfIrOperation(operation)) {
        const where = useBlocks.get(operand.value) ?? new Set<IrBlockId>()
        where.add(blockId)
        useBlocks.set(operand.value, where)
      }
      const produced = resultOfIrOperation(operation)
      if (produced !== null) definitionBlocks.set(produced.id, blockId)
    }
    block.operations.forEach((operation, index) => {
      if (operation.kind === 'constant') {
        constants.set(operation.result.id, operation.text)
        literals.set(operation.result.id, cppConstantLiteral(operation.text, operation.literal, operation.result.representation))
        if (operation.literal === 'number') numericConstants.set(operation.result.id, operation.text)
      }
      if (operation.kind === 'compute') computes.set(operation.result.id, operation)
      // `arr.push` is a `get` the emitter renders as nothing -- and one the
      // hoister is free to lift OUT of the loop that calls it, since the
      // receiver cell never changes. So the lookup is indexed body-wide and a
      // fill loop recognizes its call by the callee, not by an adjacent `get`.
      //
      // This runs in `collectCapacityHints`'s own pre-pass, before the body's
      // operations are emitted -- so `ctx.prototypeMethodReads`
      // (`emit-carrier-members.ts`'s `arrayAccessText`, the census this same
      // `array-object` receiver check otherwise shares) is not populated yet
      // and cannot be read here. `arrayBulkAppendMethodName` is the part that
      // CAN be shared this early: a module constant, not a per-body census, so
      // this and `arrayMethods`' own `push` entry (`emit-prototype-array.ts`)
      // name the one method by the same identifier rather than two
      // independent `'push'` literals free to drift apart.
      if (operation.kind === 'allocate-array-object') arrayPacks.set(operation.result.id, operation)
      if (operation.kind === 'get' && operation.receiver.representation.kind === 'array-object') {
        if (constants.get(operation.key.value) === arrayBulkAppendMethodName) pushLookups.set(operation.result.id, operation.receiver)
      }
      if (operation.kind === 'allocate-array-object') allocations.set(operation.result.id, { block: blockId, position: index })
      if (operation.kind === 'binding-read') bindingReads.set(operation.result.id, operation.declaration)
      if (operation.kind === 'binding-write') {
        const written = bindingWrites.get(operation.declaration) ?? []
        written.push({ site: { block: blockId, position: index }, value: operation.value })
        bindingWrites.set(operation.declaration, written)
      }
    })
  }

  const loops = naturalLoopsOf(graph, dominance)

  /** The array this value names, when a single allocation is the only thing its cell ever holds. */
  const allocationBehind = (value: IrValueId, loop: ReadonlySet<IrBlockId>): IrValueId | null => {
    if (allocations.has(value)) return value
    const declaration = bindingReads.get(value)
    if (declaration === undefined) return null
    const written = bindingWrites.get(declaration) ?? []
    // More than one write and the cell is not one array; a write inside the
    // loop and it is a FRESH array each iteration, which a capacity taken from
    // the whole loop would size wrongly.
    if (written.length !== 1) return null
    const only = written[0]
    if (!only || loop.has(only.site.block)) return null
    return allocations.has(only.value.value) ? only.value.value : null
  }

  /** How `bound` can be named where `at` renders, or `null` when it holds no single number the loop cannot change. */
  const capacityAt = (bound: IrOperand, loop: ReadonlySet<IrBlockId>, at: DefinitionSite): CapacitySource | null => {
    // A numeric literal bound -- `for (let i = 0; i < 256; i++)` -- stands on
    // its own text and needs neither a cell nor a defined SSA name. Read
    // straight through, because the constant's own operation is withheld by
    // the deferral census and has no variable at the allocation site.
    const literal = numericConstants.get(bound.value)
    if (literal !== undefined) return { kind: 'literal', text: literal }
    const declaration = bindingReads.get(bound.value)
    if (declaration === undefined) {
      if (ctx.deferrable.has(bound.value)) return null
      const definitions = sites.get(bound.value) ?? []
      if (definitions.some((site) => loop.has(site.block))) return null
      return definitions.every((site) => isVisible(site, at.block, at.position, dominance)) ? { kind: 'value', operand: bound } : null
    }
    // Only an ordinary cell this body owns. A host constant, function,
    // namespace or class object is not storage at all -- `emitBindingRead`
    // renders each of those by the host's own spelling and defines no variable
    // -- and a cell whose held carrier differs from the read one goes through
    // a narrowing this has no business reproducing.
    const placement = ctx.placements.get(declaration)
    if (placement?.storage.kind !== 'local' && placement?.storage.kind !== 'region') return null
    const held = placement.representation
    if (held === null || representationKey(held) !== representationKey(bound.representation)) return null
    // A cell that IS a formal needs no visibility proof: it renders as the
    // formal's own name (`EmitContext.formalCells`), which precedes every
    // statement in the frame. Its seeding write is a formality that may render
    // anywhere, and requiring the ALLOCATION to follow it refused the bound of
    // every fill loop whose count is a parameter -- which is every one of them
    // in `array_read.ts`, `array_write.ts` and `prime_sieve.ts`, the fixtures
    // the hint exists for.
    if (ctx.formalCells.has(declaration)) return { kind: 'binding', declaration }
    const written = bindingWrites.get(declaration) ?? []
    if (written.length === 0) return null
    if (written.some((write) => loop.has(write.site.block))) return null
    return written.every((write) => isVisible(write.site, at.block, at.position, dominance)) ? { kind: 'binding', declaration } : null
  }

  for (const loop of loops) {
    const header = body.blocks.get(loop.header)
    if (header?.terminator.kind !== 'branch') continue
    const test = computes.get(header.terminator.condition.value)
    if (test?.form !== 'binary' || (test.operator !== '<' && test.operator !== '<=')) continue
    const bound = test.operands[1]
    if (!bound || bound.representation.kind !== 'scalar' || bound.representation.domain !== 'number') continue

    for (const blockId of loop.blocks) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      for (const operation of block.operations) {
        if (operation.kind !== 'get') continue
        // Shares `arrayBulkAppendMethodName` with the push-lookup above so this
        // sibling names the one method by the same identifier rather than a
        // second independent `'push'` literal free to drift apart from it.
        if (constants.get(operation.key.value) !== arrayBulkAppendMethodName) continue
        if (operation.receiver.representation.kind !== 'array-object') continue
        const allocated = allocationBehind(operation.receiver.value, loop.blocks)
        if (allocated === null || ctx.capacityHints.has(allocated)) continue
        const site = allocations.get(allocated)
        if (!site) continue
        const capacity = capacityAt(bound, loop.blocks, site)
        if (capacity === null) continue
        prepass.capacityHints.set(allocated, capacity)
      }
    }

    // ...and the same loop, when the value it pushes never changes, is not a
    // loop at all: it is one bulk append. See `collectFillLoop`.
    const tested = test.operands[0]
    const counter = tested === undefined ? undefined : bindingReads.get(tested.value)
    const exit = [header.terminator.whenTrue, header.terminator.whenFalse].find((next) => !loop.blocks.has(next))
    if (counter === undefined || exit === undefined) continue
    const fill = collectFillLoop(ctx, body, loop, {
      counter,
      exit,
      bound,
      inclusive: test.operator === '<=',
      bindingReads,
      bindingWrites,
      computes,
      constants,
      useBlocks,
      definitionBlocks,
      literals,
      pushLookups,
      arrayPacks
    })
    if (fill !== null) prepass.fillLoops.set(loop.header, fill)
  }
}

/** What `collectFillLoop` is told about the loop it is judging, so it re-derives none of it. */
interface FillFacts {
  readonly counter: DeclarationId
  readonly exit: IrBlockId
  readonly bound: IrOperand
  readonly inclusive: boolean
  readonly bindingReads: ReadonlyMap<IrValueId, DeclarationId>
  readonly bindingWrites: ReadonlyMap<DeclarationId, readonly { readonly site: DefinitionSite; readonly value: IrOperand }[]>
  readonly computes: ReadonlyMap<IrValueId, ComputeOperation>
  readonly constants: ReadonlyMap<IrValueId, string>
  readonly useBlocks: ReadonlyMap<IrValueId, ReadonlySet<IrBlockId>>
  readonly definitionBlocks: ReadonlyMap<IrValueId, IrBlockId>
  readonly literals: ReadonlyMap<IrValueId, string>
  readonly pushLookups: ReadonlyMap<IrValueId, IrOperand>
  readonly arrayPacks: ReadonlyMap<IrValueId, AllocateArrayObjectOperation>
}

/**
 * A counted loop whose whole body is `array.push(<the same value>)`.
 *
 * `for (let i = 0; i <= LIMIT; i++) sieve.push(true)` is how JavaScript spells
 * "an array of LIMIT+1 trues", and it gets what it asked for: ten million
 * calls, each a capacity test, a store and a size bump. C++ spells it
 * `std::vector<char>(LIMIT + 1, 1)` and gets a memset. Measured on
 * `bench/comparison/fixtures/prime_sieve.ts`, whose sieve is exactly this:
 * 45.5ms as the loop, 36.9ms as one append -- against 36.4ms for the
 * hand-written C++, so the loop was the whole of that fixture's gap.
 *
 * Every condition is a way the rewrite could be OBSERVED:
 *  - the counter must advance by exactly one, exactly once, or the turn count
 *    is not `bound - counter`;
 *  - the receiver and the pushed value must be loop-invariant, or the elements
 *    appended are not all the same one;
 *  - the loop may hold no other operation with an effect, and nothing it
 *    defines may be read after it -- those are turns the append does not run.
 *    The `push` result is the exception: one append returns the same length the
 *    last turn would have.
 */
const collectFillLoop = (ctx: EmitContext, body: IrBody, loop: NaturalLoop, facts: FillFacts): FillLoop | null => {
  if (!invariantInLoop(facts.bound, loop, facts)) return null
  let call: CallOperation | null = null
  const packed: IrValueId[] = []
  for (const blockId of loop.blocks) {
    const block = body.blocks.get(blockId)
    if (!block) return null
    if (blockId !== loop.header && block.terminator.kind !== 'jump') return null
    for (const operation of block.operations) {
      const result = resultOfIrOperation(operation)
      if (result !== null && [...(facts.useBlocks.get(result.id) ?? [])].some((where) => !loop.blocks.has(where))) return null
      if (operation.kind === 'get') {
        if (!facts.pushLookups.has(operation.result.id)) return null
        continue
      }
      if (operation.kind === 'call') {
        if (call !== null || !facts.pushLookups.has(operation.callee.value) || operation.arguments.length !== 1) return null
        call = operation
        continue
      }
      if (operation.kind === 'allocate-array-object') {
        packed.push(operation.result.id)
        continue
      }
      if (operation.kind === 'binding-write' && operation.declaration !== facts.counter) return null
      if (!fillInertKinds.has(operation.kind)) return null
    }
  }
  const receiver = call === null ? undefined : facts.pushLookups.get(call.callee.value)
  const argument = call?.arguments[0]
  if (!call || !argument || !receiver || !advancesByOne(loop, facts)) return null
  // `push` is variadic, so the IR hands it its arguments already packed into a
  // fresh Array (`packRestArguments`) that the emitted `push` never builds. The
  // element inside that pack is the value; the pack itself is the only object
  // the loop is allowed to allocate, since anything else it built would be one
  // object per turn and the append builds none.
  const pack = facts.arrayPacks.get(argument.value)
  const only = pack?.elements.length === 1 ? pack.elements[0] : undefined
  if (packed.length !== (pack === undefined ? 0 : 1) || (pack !== undefined && only?.kind !== 'element')) return null
  const value = only?.kind === 'element' ? only.value : argument
  // A constant is the only value a fill may name that the loop itself defines:
  // its text is the whole of it, so the header can restate it. Anything else
  // has to be a name the header can already read.
  const literal = facts.literals.get(value.value) ?? null
  if (literal === null && !invariantInLoop(value, loop, facts)) return null
  const cell = facts.bindingReads.get(receiver.value)
  const array = cell === undefined ? null : denseCellName(ctx, cell)
  const counter = denseCellName(ctx, facts.counter)
  if (array === null || counter === null) return null
  // The bound renders on BOTH sides of the append -- once for the count, once
  // for the counter this leaves behind -- so a bound that reads the array being
  // appended to would render two different numbers around a `bulkAppend` that
  // changed the length between them. No terminating program can write that
  // loop, since such a bound grows exactly as fast as the counter, and that is
  // precisely why this went unstated: the rewrite rested on non-termination
  // rather than on a check. `invariantInLoop` does not cover it either -- it
  // asks whether the loop rebinds the CELL, and `data.push(v)` mutates the
  // array without writing the name. Stated so the guard is a proof rather than
  // a coincidence; `deferral-safety.ts` holds the other two sites where an
  // emitter observes a withheld read somewhere its census never placed it.
  if (cell !== undefined && (readsCell(ctx, facts.bound.value, cell) || readsCell(ctx, value.value, cell))) return null
  // Both ends INTEGRAL, or the turn count is not `bound + 1 - counter`.
  // `for (let i = 0; i < 3.5; i++)` runs four times, not three, and leaves `i`
  // at 4 rather than at 3.5 -- the count rounds one way and the counter the
  // other. Every counted push loop in practice counts in integers, and the
  // integer census has already settled which ones do.
  if (!ctx.integerBindings.has(facts.counter) || !ctx.integerValues.has(facts.bound.value)) return null
  if (receiver.representation.kind !== 'array-object') return null
  return {
    exit: facts.exit,
    counter,
    bound: facts.bound,
    inclusive: facts.inclusive,
    array,
    value,
    literal,
    element: receiver.representation.element
  }
}

/**
 * One counted `push` loop, rendered at its header as a single bulk append.
 *
 * The loop's own blocks still render, unreachable, behind this `goto`: nothing
 * reads what they define (`collectFillLoop` checked), and the C++ compiler
 * drops them. Emitting them anyway keeps every label this body's other jumps
 * may name, and keeps this a terminator substitution rather than a rewrite of
 * the block list.
 */
/**
 * The pushed element, spelled in the ARRAY's element type.
 *
 * A restated literal carries the constant's own text, and C++ reads `7` as an
 * `int`. `bulkAppend` initializes its cell with a brace -- `Cell{value}` --
 * where an `int` reaching a `double` element is a narrowing conversion, which
 * is ill-formed rather than merely warned about: `for (let i = 0; i < n; i++)
 * values.push(7)` into a `number[]` emitted a translation unit clang refuses.
 * The ordinary push path never hits this because it renders its elements
 * through the pack, which already aligned them.
 *
 * Cast only for a scalar element, which is the whole of the narrowing rule's
 * reach here: a string literal reaching `std::string` and a `bool` reaching
 * `bool` are not narrowing conversions, and a blanket `static_cast` to a
 * handle or reference carrier would be a new way to be wrong.
 */
const appendedElementText = (ctx: EmitContext, fill: FillLoop): string => {
  if (fill.literal === null) return operandText(ctx, fill.value)
  return fill.element.kind === 'scalar' ? `static_cast<${cppTypeOf(fill.element)}>(${fill.literal})` : fill.literal
}

export const emitFillLoop = (ctx: EmitContext, lines: string[], fill: FillLoop, exitLabel: string): void => {
  const count = `gea_fill_${ctx.declarations.length}`
  ctx.declarations.push({ name: count, type: 'double' })
  const reach = `static_cast<double>(${operandText(ctx, fill.bound)})${fill.inclusive ? ' + 1' : ''}`
  lines.push(`${count} = ${reach} - static_cast<double>(${fill.counter});`)
  lines.push(`gea::runtime::array::bulkAppend(${fill.array}, ${appendedElementText(ctx, fill)}, ${count});`)
  // The counter is left where the loop would have left it -- one past the last
  // turn it ran -- and untouched when it ran none, which is the case the count
  // is not positive in.
  lines.push(`if (${count} > 0) ${fill.counter} = static_cast<long long>(${reach});`)
  lines.push(`goto ${exitLabel};`)
}

/** The operation kinds a fill loop may hold besides its one `push`: reading the counter, advancing it, testing it. */
const fillInertKinds: ReadonlySet<string> = new Set(['binding-read', 'binding-write', 'compute', 'constant'])

/**
 * Whether the loop can change what this operand names.
 *
 * Through the CELL when the operand is a binding read, because that is how a
 * fill loop names both its array and its bound: `const data = []` stores into a
 * cell and every `data.push(...)` reads it back, so the receiver at the push is
 * a fresh value defined INSIDE the loop and its own definition site answers the
 * wrong question -- the same reasoning `collectCapacityHints` states above.
 */
const invariantInLoop = (operand: IrOperand, loop: NaturalLoop, facts: FillFacts): boolean => {
  const cell = facts.bindingReads.get(operand.value)
  if (cell !== undefined) return !(facts.bindingWrites.get(cell) ?? []).some((write) => loop.blocks.has(write.site.block))
  const defined = facts.definitionBlocks.get(operand.value)
  return defined === undefined || !loop.blocks.has(defined)
}

/** Exactly one advance of the counter inside the loop, by exactly one. */
const advancesByOne = (loop: NaturalLoop, facts: FillFacts): boolean => {
  const writes = (facts.bindingWrites.get(facts.counter) ?? []).filter((write) => loop.blocks.has(write.site.block))
  if (writes.length !== 1) return false
  const advance = writes[0] === undefined ? undefined : facts.computes.get(writes[0].value.value)
  if (advance === undefined) return false
  if (advance.form === 'update') return advance.operator === '++'
  if (advance.form !== 'binary' || advance.operator !== '+') return false
  const [left, right] = advance.operands
  if (!left || !right) return false
  const other = facts.bindingReads.get(left.value) === facts.counter ? right : left
  return facts.constants.get(other.value) === '1'
}

/** The plain C++ name a dense window may read its array or its counter through, or `null` when this body has no such name for the cell. */
const denseCellName = (ctx: EmitContext, declaration: DeclarationId): string | null => {
  const placement = ctx.placements.get(declaration)
  if (!placement) return null
  if (placement.storage.kind === 'region') return cppGlobalName(declaration)
  if (placement.storage.kind !== 'local' || placement.storage.owner !== ctx.owner) return null
  if (ctx.captures.isBoxed(declaration)) return null
  return bindingReference(ctx, declaration, 'a dense Array window').name
}

/** One dense-window operand as a `long long`; the census already narrowed most of them, and the rest are ordinary `number` cells. */
const denseIntegerText = (ctx: EmitContext, operand: IrOperand): string =>
  ctx.integerValues.has(operand.value) ? operandText(ctx, operand) : `static_cast<${cppNarrowedIntegerType}>(${operandText(ctx, operand)})`

/**
 * Admits the dense windows this body can actually render, and records them on
 * the context for the access sites to find.
 *
 * `ir/dense-loops.ts`'s `admittedDenseLoopPlanOf` owns every question that is
 * about the PROGRAM: whether the integer census narrowed an index, the
 * wrapped-window exemption from that test, and whether anything survives once
 * an unnamed or un-narrowed window is dropped. The one thing left here is the
 * one thing genuinely about this backend's own storage -- whether a cell has
 * a plain C++ name in this body at all (`denseCellName`) -- handed down as the
 * policy hook that function cannot answer for itself.
 *
 * Invariant 5 audit (invariant 5: no write during render): `denseAccesses`,
 * `denseArrays`, `denseGroups` and `denseLengths` are written ONLY here, and
 * `emitBody` (`emit.ts`) calls this once, after the integer census and before
 * `sealFactFieldsForRender` -- so every one of these four collections is a
 * settled FACT by the time the first operation renders, and none of them
 * needs an entry in `emit-context.ts`'s `renderMutableEmitContextFields`.
 * Contrast `denseIndices` (a NAMING table): its window is admitted here too,
 * but its content -- a minted `gea_dense_index_<N>` local -- does not exist
 * until a `%` compute actually renders (`emit.ts`'s `emitBinaryOperation`),
 * which is why that one field, alone of this group, is on the whitelist.
 */
export const admitDenseWindows = (ctx: EmitContext, prepass: EmitBodyPrepassFacts, body: IrBody): void => {
  const plan = denseLoopsOf(body)
  if (plan.arrays.length === 0) return
  const admitted = admittedDenseLoopPlanOf(plan, ctx.integerValues, (declaration) => denseCellName(ctx, declaration) !== null)
  for (const [operation, access] of admitted.accesses) prepass.denseAccesses.set(operation, access)
  for (const array of admitted.arrays) {
    prepass.denseArrays.push(array)
    materializeDenseReference(prepass, array.reference)
  }
  for (const [value, ordinal] of admitted.lengths) prepass.denseLengths.set(value, ordinal)
  for (const [ordinal, group] of admitted.groups) prepass.denseGroups.set(ordinal, group)
}

/** An array named at the preheader has to be a value that materialized, not one whose text is substituted at each use. */
const materializeDenseReference = (prepass: EmitBodyPrepassFacts, reference: DenseReference): void => {
  if (reference.kind === 'value') prepass.deferrable.delete(reference.operand.value)
  if (reference.kind === 'element') materializeDenseReference(prepass, reference.holder)
}

/** One window's array as the preheader names it, and what has to hold before that name may be dereferenced. */
interface DenseHolder {
  readonly text: string
  readonly guard: readonly string[]
}

/**
 * The array a window indexes, unpacked at the preheader.
 *
 * A cell or a value is simply named. A ROW is loaded -- `grid[i]` -- and that
 * load is itself an element access this has to prove is in range first, so the
 * row comes back behind a null check rather than as a bare name: every later
 * mention of it is guarded by `guard`, and the `&&` chain the conditions are
 * joined into is what keeps the dereference from happening when it is not.
 */
const denseHolderOf = (ctx: EmitContext, lines: string[], reference: DenseReference, array: DenseArray): DenseHolder | null => {
  if (reference.kind === 'cell') {
    const name = denseCellName(ctx, reference.declaration)
    if (name === null) return null
    const held = ctx.placements.get(reference.declaration)?.representation
    return { text: (held && narrowedLoadText(held, reference.representation, name)) ?? name, guard: [] }
  }
  if (reference.kind === 'value') {
    const stored = operandText(ctx, reference.operand)
    return { text: narrowedLoadText(reference.storage, reference.operand.representation, stored) ?? stored, guard: [] }
  }
  const holder = denseHolderOf(ctx, lines, reference.holder, array)
  if (holder === null) return null
  const key = denseIntegerText(ctx, reference.key)
  const row = cppDenseRowName(array.ordinal)
  ctx.declarations.push({ name: row, type: `gea::ArrayObject<${cppTypeOf(array.element)}>*` })
  const reachable = [
    ...holder.guard,
    `${holder.text}->holes.empty()`,
    `(${key}) >= 0`,
    `(${key}) < static_cast<${cppNarrowedIntegerType}>(${holder.text}->cells.size())`
  ]
  lines.push(`${row} = (${reachable.join(' && ')}) ? ${holder.text}->elementAtIndex(${key}).get() : nullptr;`)
  return { text: row, guard: [`${row} != nullptr`] }
}

/**
 * The preheader statements one loop's dense windows need: an element pointer
 * per array, and the one loop-invariant condition that makes indexing it sound.
 *
 * The condition is per LOOP rather than per array -- `ir/dense-loops.ts`
 * explains why -- and it says three things about every window in the loop: the
 * array holds no holes, the lowest index the loop can reach is not negative,
 * and the highest is inside the storage the pointer names. `bound + step` is
 * the highest: the loop's test admits `bound` (or `bound - 1`), and one turn of
 * the body may advance the counter once more before it reads.
 */
export const emitDenseSetup = (ctx: EmitContext, lines: string[], blockId: IrBlockId): void => {
  const groups = [...ctx.denseGroups.values()].filter((group) => group.preheader === blockId)
  if (groups.length === 0) return
  // Which arrays the windows STORE into. A store's integrity guard -- is the
  // array frozen -- is asked here, once, and folded into the flag, rather than
  // at every store: `ir/dense-loops.ts` admits a window only when nothing in
  // the loop can reach the array except the indexed accesses themselves, so
  // nothing in the loop can freeze it either. Asked per store, the guard's
  // cold half was a call the backend had to assume could write anything, which
  // kept the counter load and the null test inside `matrix_multiply`'s inner
  // loop and the loop itself scalar: 27.4 ms against 4.7 for the same loop
  // hand-written.
  const stored = new Set<number>()
  for (const [operation, access] of ctx.denseAccesses) if (operation.kind !== 'get') stored.add(access.array)
  for (const group of groups) {
    const said: string[] = group.parent === null ? [] : [cppDenseFlagName(group.parent)]
    for (const array of ctx.denseArrays.filter((candidate) => candidate.group === group.ordinal)) {
      const holder = denseHolderOf(ctx, lines, array.reference, array)
      if (holder === null) continue
      const pointer = cppDensePointerName(array.ordinal)
      const cells = `${holder.text}->cells`
      const data = array.typed === null ? `${cells}.data()` : `${holder.text}->data()`
      const size = array.typed === null ? `${cells}.size()` : `${holder.text}->size()`
      const shape = array.typed === null ? [`${holder.text}->holes.empty()`] : []
      const writable =
        array.typed === null && stored.has(array.ordinal) && ctx.nativeIntegrityRestricted
          ? [`gea::nativeOwnFieldsWritable(${holder.text})`]
          : []
      ctx.declarations.push({
        name: pointer,
        type: array.typed === null ? `gea::ArrayObject<${cppTypeOf(array.element)}>::Cell*` : `${cppScalarType(array.typed)}*`
      })
      lines.push(`${pointer} = ${holder.guard.length === 0 ? data : `(${holder.guard.join(' && ')}) ? ${data} : nullptr`};`)
      // A wrapped window proves its indices from the array's own length, so
      // the only thing left to say is that the length is one a remainder can
      // land inside of, and that no hole sits in the way. See `DenseArray.wrapped`.
      if (array.wrapped) {
        // What the remainder's range has to fit inside. The array's own length
        // bounds its indices by definition, so `size() > 0` is the whole of it
        // -- it only rules out the `x % 0` that would be NaN. A CONSTANT
        // modulus is bounded by itself instead, and nothing ties that number to
        // this array, so the length has to cover it: `table[i % 16]` is a
        // window exactly when the table holds sixteen elements or more.
        const reach = array.modulus === null ? `${cells}.size() > 0` : `${cells}.size() >= ${array.modulus}`
        said.push(...holder.guard, `${holder.text}->holes.empty()`, reach, ...writable)
        // The divisor of every index in this window, read here rather than on
        // every turn. Nothing in the loop resizes the array -- that is what the
        // window's own admission proved -- but only this hoist tells the
        // backend so. See `DenseLoopPlan.lengths`.
        if ([...ctx.denseLengths.values()].includes(array.ordinal)) {
          const length = cppDenseLengthName(array.ordinal)
          const divisor = cppDenseDivisorName(array.ordinal)
          ctx.declarations.push({ name: length, type: 'double' }, { name: divisor, type: 'gea::Divisor' })
          lines.push(`${length} = ${holder.text}->length();`, `${divisor} = gea::buildDivisor(${length});`)
        }
        continue
      }
      const seed = denseCellName(ctx, array.counter) ?? ''
      const step = array.step === null ? '1' : operandText(ctx, array.step)
      // The holder's own guard comes FIRST, and the chain is short-circuiting:
      // a row that could not be reached is a null pointer, and nothing after
      // this may dereference it.
      said.push(...holder.guard, ...shape, ...writable)
      for (const offset of array.bases) {
        const base = offset === null ? '0' : operandText(ctx, offset)
        said.push(
          `gea::denseIndexWindow(${size}, ${seed}, ${base}, ${operandText(ctx, array.bound)}, ${step}, ${array.inclusive}, ${array.widened})`
        )
      }
    }
    const flag = cppDenseFlagName(group.ordinal)
    ctx.declarations.push({ name: flag, type: 'bool' })
    lines.push(`${flag} = ${said.length === 0 ? 'true' : said.join(' && ')};`)
  }
}

/**
 * A record whose fields are a closed, contiguous run of numeric keys --
 * `0`, `1`, ... with no gap -- poured into the array it physically is.
 *
 * `semantics/normalize/structural.ts`'s `restParameterArrayElementAt` is what
 * makes this pairing reachable at all: an unannotated `...rest` parameter's
 * checker type is a tuple with optional trailing elements (an overloaded call
 * shape or a signature's own optional tail), and that function collapses
 * `rest` ITSELF to the array it is at runtime. But every other place the SAME
 * open-arity tuple still surfaces -- the enclosing function's OWN callable
 * ABI, still stated from the checker's tuple type -- keeps publishing the
 * `record(0?:..., 1?:...)` view, and a call site that reads `rest[0]`/
 * `rest[1]` needs a real conversion between the two, not a second producer
 * disagreeing with the first about which one is true.
 *
 * Every field must convert into the array's ONE element carrier
 * (`widenedStoreText`, asked rather than restated -- the identical function
 * `registry.widening`'s dynamic-target branch calls, so a field that boxes
 * into a `dynamic` element today boxes it the same way tomorrow). A record
 * with accessors, zero fields, or a non-contiguous key set is refused: the
 * first has no storage to read positionally, the second has no element type
 * to publish, and the third is not this shape at all -- `tuple-destructuring.
 * ts`'s `representationIsPositionalTupleRecord` asks the identical question
 * for a destructuring read, kept as a separate, smaller local check here
 * rather than imported, since `targets/cpp` does not depend on `preflight`.
 *
 * `field.required` (model.ts) is not consulted, for the same reason
 * `records.ts`'s own field-layout renderer does not: an optional field's
 * struct member is unconditionally present today (no physical presence bit),
 * so there is no runtime state to ask -- every field converts and every
 * element pushes, an array of exactly `source.fields.length` elements. A
 * caller that omitted a trailing argument the checker allowed and a caller
 * that passed one explicitly are indistinguishable at this carrier, which is
 * the same fidelity gap `records.ts` already documents rather than a new one
 * introduced here.
 */
export const recordCastableToArray = (
  source: Extract<Representation, { kind: 'record' }>,
  target: Extract<Representation, { kind: 'array-object' }>
): boolean => {
  if (source.accessors.length > 0) return false
  if (source.fields.length === 0) return false
  if (target.ownership !== 'shared-refcount') return false
  if (!source.fields.every((field, index) => field.key === String(index))) return false
  // `widenedStoreText` returns null both when no widening exists AND when the
  // two representations already match (its own top-line sentinel: "nothing to
  // convert"). Treating both as failure rejected every field already carrying
  // the target's element representation -- the exact shape of the rest-array
  // case, where the first field is already `dynamic` and only the trailing
  // optional field needs boxing. A field counts as castable if it either has
  // a real widening text or is already representation-identical to the target.
  // A PROBE: "false" is legitimate, so lattice bottom is caught here, not
  // left to crash `widenedStoreText` deeper in (mongodb's `Filter`).
  if (containsUnresolved(target.element)) return false
  const targetKey = representationKey(target.element)
  const castable = (field: RecordField): boolean =>
    representationKey(field.value) === targetKey || widenedStoreText(target.element, field.value, '') !== null
  return source.fields.every((field) => !containsUnresolved(field.value) && castable(field))
}

export const recastedRecordToArrayText = (
  source: Extract<Representation, { kind: 'record' }>,
  target: Extract<Representation, { kind: 'array-object' }>,
  text: string
): string | null => {
  if (!recordCastableToArray(source, target)) return null
  const fieldArrow = source.ownership === 'shared-refcount' ? '->' : '.'
  const elementType = cppTypeOf(target.element)
  const pushes = source.fields
    .map((field) => {
      const raw = `gea_from${fieldArrow}${cppRecordFieldName(field.key)}`
      // `widenedStoreText` returns `null` for "already the array's own element
      // carrier, nothing to convert" -- `raw` unchanged is that value, the
      // identical fallback its every other caller in this file uses.
      return `gea_arr->push(${widenedStoreText(target.element, field.value, raw) ?? raw});`
    })
    .join(' ')
  return `[](const ${cppTypeOf(source)}& gea_from) { auto gea_arr = gea::makeRef<gea::ArrayObject<${elementType}>>(); ${pushes} return gea_arr; }(${text})`
}
