import type { ElementChildOperation, ElementOperation, ElementPropOperation, IrBlockId, IrBody, IrOperation } from '../../ir/model.js'
import { operandsOfIrOperation } from '../../ir/queries.js'
import { stringConstantsOf } from '../../ir/dead-values.js'
import type { FunctionId, IrValueId } from '../../identity/ids.js'
import {
  bindingReference,
  cppReceiverName,
  createCppEmitBlockedError,
  defineValue,
  nameOfValue,
  operandText,
  type EmitContext
} from './emit-context.js'
import { memberAccessOperator } from './emit-carrier-members.js'
import { alignedValueText } from './emit-narrowing.js'
import { booleanTestText } from './emit-presence.js'
import { cppReactiveRevisionFieldName, recordFieldsOfShape, representationCanCell } from './records.js'
import type { ReactiveDependency } from './reactive-dependencies.js'
import type { IrOperand } from '../../ir/model.js'
import type { Representation } from '../../representation/model.js'
import { cppRecordFieldName, cppStringLiteral, cppTypeOf } from './types.js'

/**
 * The three JSX operations, rendered against `gea::jsx` in the runtime header.
 *
 * Split out of `emit.ts` because they are one subject with one shared
 * constraint: C++ has no reflection, so anything that depends on knowing a
 * generated struct's members has to be spelled HERE, by the emitter that does
 * know them, rather than by a template in the header. `emitElementProp`'s style
 * handling is the whole of that constraint in one place.
 */

export const emitElement = (ctx: EmitContext, lines: string[], operation: ElementOperation): void => {
  const representation = operation.result.representation
  if (representation.kind !== 'native-handle') {
    throw createCppEmitBlockedError(
      `runtime-helper:element:${operation.form}`,
      `carries a "${representation.kind}" result, but a host element is an opaque handle and needs a "native-handle" carrier; ` +
        "no host protocol is bound to this program's JSX element type"
    )
  }
  // A fragment names no tag, so it cannot go through the create-with-a-tag
  // recipe below; what it builds is the host's own answer, stated by the
  // plugin that installs that host (`PluginCapabilities.elementFragment`) and
  // rendered verbatim here. A host with none leaves this `null` and the
  // fragment is refused by name, like any other unclaimed spelling.
  if (operation.form === 'fragment') {
    if (ctx.hosts.fragment === null) {
      throw createCppEmitBlockedError(
        'runtime-helper:element:fragment',
        'a JSX fragment builds whatever the host that installed the element tree says it builds, and no installed plugin states one'
      )
    }
    lines.push(`${defineValue(ctx, operation.result)} = ${ctx.hosts.fragment};`)
    return
  }
  if (operation.form !== 'intrinsic') {
    throw createCppEmitBlockedError(
      `runtime-helper:element:${operation.form}`,
      `a "${operation.form}" element names a value rather than a tag the JSX namespace declares; what such an element builds is ` +
        'stated by the library that declared it, and no installed plugin claimed this one'
    )
  }
  const tag = operation.tag
  if (!tag) throw createCppEmitBlockedError('runtime-helper:element:intrinsic', 'an intrinsic element names no tag')
  const name = defineValue(ctx, operation.result)
  // A leaf that IS its text is a different node in the host's model, not a
  // decorated container -- and the kind is fixed at creation, which is why
  // lowering decided it there rather than leaving it to be discovered here when
  // the child arrives. Recorded so the child operation, which names only the
  // node, writes into it instead of appending to it.
  //
  // The TAG still travels. Collapsing the element is a choice about which host
  // node holds the characters, not about what the element IS -- and the tag is
  // the whole of what every element-selector CSS rule matches on. Dropping it
  // took `h1 { font-size: 32px }` out of reach of the very node it was written
  // for, silently, because an unmatched rule is not an error.
  if (operation.textLeaf) {
    lines.push(`${name} = gea::jsx::createTextLeaf<${cppTypeOf(representation)}>(${operandText(ctx, tag)});`)
    return
  }
  lines.push(`${name} = gea::jsx::create<${cppTypeOf(representation)}>(${operandText(ctx, tag)});`)
}

/**
 * One JSX prop.
 *
 * Almost every prop is handed whole to `gea::jsx::prop`, which dispatches on
 * the value's C++ type -- an attribute, or an event listener -- exactly as the
 * host's own overload set is written to.
 *
 * A record-carried value is the one shape that cannot be: `style={{ width:
 * '50%' }}` allocates a generated struct, and C++ has no reflection with which
 * a header could name its members. The shape is a fact this emitter already
 * holds, in the carrier's own `fields`, so the block is spelled out here --
 * one `styleProperty` call per member, each still dispatching on that member's
 * own C++ type. The prop's name travels with every call so the host can refuse
 * an object handed to a prop that has no object rule, rather than write style
 * properties the program never asked for.
 *
 * `record-with-index` deliberately does not take this path. Its open half is a
 * dictionary whose keys exist only at runtime; emitting its named fields alone
 * would silently drop the rest of the block, so it falls through to `prop` and
 * is refused there by name.
 */
export const emitElementProp = (ctx: EmitContext, lines: string[], operation: ElementPropOperation): void => {
  const node = operandText(ctx, operation.node)
  const key = operandText(ctx, operation.key)
  const value = operation.value.representation
  // A style object reaches C++ as a generated struct, and C++ has no
  // reflection to enumerate one -- so the emitter, which does know the shape,
  // spells one `styleProperty` call per member. `gea::jsx::prop` deliberately
  // has no rule for it and static_asserts instead (see its comment).
  //
  // BOTH record carriers, because a style literal can arrive as either. A bare
  // `style={{ width: '50%' }}` whose prop type is anonymous derives a
  // structural `record` with its fields inline; one whose prop is DECLARED
  // (`style?: Style`) takes that declared type as its layout -- correctly, so
  // the value has one identity rather than two -- and a declared name is
  // carried nominally as `native-record-ref`, whose fields live in the sealed
  // structural table rather than on the carrier. `recordFieldsOfShape` reads
  // them back from the one authority that owns them. Missing this second
  // carrier sent 17 JSX programs into `prop`'s static_assert.
  const styled =
    value.kind === 'record'
      ? { ownership: value.ownership, fields: value.fields }
      : value.kind === 'native-record-ref'
        ? { ownership: value.ownership, fields: recordFieldsOfShape(ctx.deriver, value.shapeId) }
        : null
  const styleFields = styled?.fields ?? null
  if (styled && styleFields) {
    const receiver = `${operandText(ctx, operation.value)}${memberAccessOperator(styled.ownership)}`
    // Members this literal was initialized from, so a member wired to an
    // expression is recognisable as one. A style object is written member by
    // member (C++ cannot enumerate a struct), and each member is an
    // independent value with its own dependencies -- so each binds
    // separately, exactly the split v1's own `emitTemplateStyleSlot` makes
    // between its static and dynamic members.
    const sources = ctx.recordFieldSources.get(operation.value.value)
    for (const field of styleFields) {
      const property = cppStringLiteral(cssPropertyName(field.key))
      const source = sources?.get(field.key)
      const computed = source ? reactiveThunkPlan(ctx, node, source) : null
      if (computed) {
        lines.push(
          ...reactiveApplyBlock(`gea::jsx::reactiveStyleApply(${node}, ${key}, ${property}, ${computed.thunk})`, computed.subscriptions)
        )
        continue
      }
      lines.push(`gea::jsx::styleProperty(${node}, ${key}, ${property}, ${receiver}${cppRecordFieldName(field.key)});`)
    }
    return
  }
  // A candidate class table's own lines were withheld (see
  // `EmitContext.classTableRoots`), and this is where they are settled: the
  // reactive path claiming the prop needs the table, so its lines are replayed
  // ahead of the apply; declining is the condition under which the table is
  // spelled away and its lines dropped. The claim is rendered into a scratch
  // array so that the withheld lines still precede it.
  const table = ctx.classTableRoots.get(operation.value.value)
  const withheld = table === undefined ? null : (ctx.pendingClassTableLines.get(table) ?? [])
  const claimed: string[] = []
  if (emitObjectPropEntries(ctx, claimed, operation, node, key, value)) {
    if (withheld) lines.push(...withheld)
    lines.push(...claimed)
    return
  }
  if (table !== undefined && emitClassTokens(ctx, lines, operation, node, key, table)) return
  if (withheld) lines.push(...withheld)
  const computed = reactiveThunkPlan(ctx, node, operation.value)
  if (computed) {
    lines.push(...reactiveApplyBlock(`gea::jsx::reactivePropApply(${node}, ${key}, ${computed.thunk})`, computed.subscriptions))
    return
  }
  const reactive = reactiveMemberPointer(ctx, operation.value)
  if (reactive) {
    lines.push(`gea::jsx::reactiveProp(${node}, ${key}, ${reactive.receiver}, ${reactive.member});`)
    return
  }
  lines.push(`gea::jsx::prop(${node}, ${key}, ${operandText(ctx, operation.value)});`)
}

/**
 * A `class={{ base: true, 'is-on': flag }}` block, wired ENTRY BY ENTRY, or
 * `false` when this prop is not one that can be.
 *
 * The style form above and this one are the same problem answered by two
 * different carriers, and the difference is what makes this a separate branch
 * rather than a case of that one. A style literal derives a generated STRUCT,
 * so its members are emitter-visible names and each gets its own
 * `styleProperty` call; a class map is declared with an index signature
 * (`ClassMap` in the elements package), so its literal derives a
 * `gea::Dictionary` -- one value, whose members exist only as runtime table
 * entries. `prop` therefore takes the table WHOLE and `objectProp` rebuilds the
 * entire space-separated attribute from it, which is why there is no per-entry
 * host rule to hang a per-entry apply on.
 *
 * What was wrong before this existed: `plugins/gea/reactive-slots.ts` claims
 * such a literal's members individually -- correctly, and for the same reason
 * it claims a style literal's -- so `'is-on': this.opaque` really does lower to
 * a thunk. But nothing downstream asked for it: the allocation CALLED the thunk
 * once to fill the table, and the prop fell through to the once-only
 * `gea::jsx::prop`. The program compiled, linked, ran, and simply never changed
 * its class attribute again. A silent wrongness, not a refusal.
 *
 * Claiming the literal WHOLE instead -- one thunk returning the table -- is not
 * the fix, and was measured not to be: an IIFE around a contextually-typed
 * object literal gives the arrow an inferred return type computed from the
 * literal's own members while the literal keeps the attribute's contextual type,
 * so the thunk returns a `Dictionary` from a function whose C++ return type is
 * the generated struct that inference minted (`no viable conversion from ...
 * Ref<gea::Dictionary<...>> to ... Ref<gea_record_type_4000>`). Two TS types for
 * one expression. The member claims are the ones that are right.
 *
 * So the re-runnable unit is: write this entry back into the table the first
 * render already built, then re-apply the whole prop. Re-applying is what makes
 * it correct rather than merely cheap -- `objectProp` writes the class
 * attribute as a set built from every truthy key, so a per-entry write that did
 * not re-run it would leave the attribute stale, and re-running it is
 * idempotent by construction (the same reason `reactivePropApply` delegates to
 * `prop`).
 *
 * The entry's value is reconciled HERE and not in the header. The table's value
 * type is `ClassMap`'s declared union, so `flag`'s `bool` has to become an arm
 * of it, and a `gea::TaggedUnion` has no converting assignment from an arm
 * type; `convertedValueText` is the one authority that spells that store, and
 * it is the same call `emit-allocation.ts` makes to fill this very table.
 *
 * It asked `widenedStoreText` directly until 2026-09-03, which spells the
 * widening half only. A dynamic value reaching this table has to be NARROWED
 * out of its box first, and that direction returned `null` and fell through to
 * the raw operand -- one of eight sites in the emitter sharing that shape.
 * `convertedValueText` ends in this same `widenedStoreText` call, so the
 * widening story above is unchanged.
 *
 * Two stated gaps, both falling through to the once-only path rather than
 * binding to the wrong thing:
 *
 *   - a table that is not `shared-refcount`. Each entry's apply captures the
 *     table, and a by-value table would give every apply its own COPY -- entry
 *     A re-propping from its copy would revert whatever entry B last wrote.
 *   - a table this frame does not name by a plain identifier, which cannot
 *     appear in a lambda capture list.
 *
 * A THUNK this frame does not so name used to be a third, and is not one any
 * more: it is bound to a local first and the capture list names that. See the
 * loop.
 */
const emitObjectPropEntries = (
  ctx: EmitContext,
  lines: string[],
  operation: ElementPropOperation,
  node: string,
  key: string,
  value: Representation
): boolean => {
  if (value.kind !== 'dictionary' || value.ownership !== 'shared-refcount') return false
  // Recorded for every record SHAPE, the dictionary path included
  // (`emit-allocation.ts`), which is what makes a table's entries reachable
  // from here at all.
  const sources = ctx.recordFieldSources.get(operation.value.value)
  if (!sources) return false
  if (value.key === 'symbol' && sources.size > 0) {
    // Sibling of the `element:<form>` allocation rows, one level down: this is
    // an `element-prop` write's own reactive-dictionary sub-capability, which
    // no `ElementOperation` form's key would name.
    throw createCppEmitBlockedError(
      'runtime-helper:element-prop:symbol-keyed-dictionary',
      'a reactive symbol-keyed object prop needs each computed Symbol expression, but this field-source table retains only canonical field names'
    )
  }
  const table = operandText(ctx, operation.value)
  if (!isPlainName(table)) return false
  const subscript = memberAccessOperator(value.ownership) === '->' ? `(*${table})` : table
  const blocks: string[] = []
  let named = 0
  for (const [entry, source] of sources) {
    const computed = reactiveThunkPlan(ctx, node, source)
    if (!computed) continue
    // A CAPTURELESS thunk has no variable to be named by, and the capture list
    // below can hold nothing else. `emit.ts`'s dead-value rule elides such a
    // thunk's producer -- its only call is by name -- so `deferredTexts` spells
    // it as the prvalue it is, `gea::CallableObject<bool()>{&body_thunk,
    // nullptr}`. Skipping the entry on that ground dropped it: `class={{ lit:
    // store.engaged }}` fell through to the once-only `classTokens` and never
    // changed its attribute again, while the SAME expression bound correctly as
    // a style member, whose `reactiveStyleApply` is a plain argument and takes
    // the prvalue as written. The difference was the lambda, not the thunk.
    //
    // So the prvalue is given a name rather than refused -- one `const auto`
    // ahead of the apply, which the capture list then names. Scoped by the
    // node's own variable, which is unique within the body, so two elements'
    // tables cannot collide.
    let thunk = computed.thunk
    if (!isPlainName(thunk)) {
      thunk = `gea_class_thunk_${node}_${named++}`
      blocks.push(`const auto ${thunk} = ${computed.thunk};`)
    }
    // Numeric dictionaries retain canonical PropertyKey text as their safe
    // physical key, so NaN and infinities never enter an ordered double map.
    const entryKey = cppStringLiteral(entry)
    const call = `${thunk}.call()`
    const written = alignedValueText(ctx, 'emit-jsx.ts:276', computed.origin.representation, value.value, call) ?? call
    const write = `[${table}, ${thunk}]() { ${subscript}[${entryKey}] = ${written}; }`
    blocks.push(...reactiveApplyBlock(`gea::jsx::reactiveObjectPropApply(${node}, ${key}, ${table}, ${write})`, computed.subscriptions))
  }
  // No reactive entry means nothing here has anything to say about this prop,
  // and it takes the path it always took.
  if (blocks.length === 0) return false
  lines.push(...blocks)
  return true
}

/**
 * Whether this frame names a value by something that can appear in a C++ lambda
 * capture list -- an identifier, and not an expression that happens to have
 * been rendered inline.
 *
 * Spelled as a character walk because `targets/cpp` may hold no RegExp literal.
 */
const isPlainName = (text: string): boolean => {
  const first = text.slice(0, 1)
  if (first === '') return false
  for (const character of text) {
    const alphabetic = character.toLowerCase() !== character.toUpperCase()
    const digit = character >= '0' && character <= '9'
    if (!alphabetic && !digit && character !== '_') return false
  }
  return !(first >= '0' && first <= '9')
}

/**
 * The CSS property a style member names.
 *
 * `style={{ backgroundColor: c }}` writes the member in the spelling the
 * declared style type uses -- camelCase, because that is what an object
 * literal's keys can be -- and a stylesheet takes the hyphenated one. The two
 * are the same property, and the mapping between them is CSSOM's own
 * (`CSS2Properties`): an uppercase letter is a hyphen plus its lowercase, so a
 * leading one produces the leading hyphen a vendor-prefixed property needs
 * (`WebkitTransform` -> `-webkit-transform`).
 *
 * Emitting the member name unconverted is invisible rather than wrong-looking:
 * a stylesheet classifies an unknown property name and drops it, so the
 * program compiles, links, runs, and silently renders without that one
 * declaration. `backgroundColor` on gea's engine is exactly that -- 64 balls
 * laid out at the right coordinates in no colour at all.
 *
 * Spelled as a character walk because `targets/cpp` may hold no RegExp
 * literal, and the rule is one branch per character anyway.
 */
const cssPropertyName = (member: string): string => {
  let name = ''
  for (const character of member) {
    const lower = character.toLowerCase()
    name += lower === character ? character : `-${lower}`
  }
  return name
}

/**
 * The pointer-to-member a reactive JSX position subscribes through, or `null`
 * when this value did not come from a cell.
 *
 * Two conditions, and both are the same one asked of two authorities that must
 * not drift: the read was recorded as coming from a field the plugin marked
 * reactive (`emit-properties.ts`), AND that field's carrier is one the struct
 * renderer actually celled (`representationCanCell`, the renderer's own
 * predicate rather than a copy of it). A field marked reactive whose carrier
 * cannot be celled is a plain member in the emitted struct, and binding to it
 * would deduce `Signal<T>` against a bare `T` -- a template-deduction error in
 * clang instead of a named refusal here. Reading the renderer's predicate is
 * what makes the two answers one answer.
 *
 * Such a field falls through to the ordinary, once-only rendering below, which
 * is what it did before any of this existed. It is a real gap -- an array field
 * of a reactive class does not re-render -- and it is left visible rather than
 * papered over with a cell that cannot detect its own mutation.
 */
const reactiveMemberPointer = (
  ctx: EmitContext,
  operand: ElementChildOperation['child']
): { readonly receiver: string; readonly member: string } | null => {
  const read = ctx.reactiveFieldReads.get(operand.value)
  if (!read || !representationCanCell(operand.representation)) return null
  return { receiver: operandText(ctx, read.receiver), member: `&${read.struct}::${cppRecordFieldName(read.key)}` }
}

/**
 * The subscription block a JSX position wired to an EXPRESSION renders, or
 * `null` when this value is not one.
 *
 * `class={todo.done ? 'a' : 'b'}` cannot be bound by a pointer-to-member the
 * way a bare `{this.count}` can: a conditional is control flow, not a load, and
 * there is no single member to point at. The gea plugin's source transform
 * (`plugins/gea/reactive-slots.ts`) makes it a THUNK -- `(() => (expr))()` --
 * which lowers to an ordinary `CallableObject` allocation plus a call of it,
 * so the re-runnable unit exists in the emitted C++ already and needs no
 * re-emission of the expression here. This finds it: the value came from a
 * call, the callee was a callable this body allocated, and the body behind it
 * reads at least one reactive cell.
 *
 * `null` is not a failure. Every position that is not such a call, and every
 * such call whose body reads no cell (a constant slot, or one over plain
 * fields), falls through to the ordinary once-only rendering below -- which is
 * exactly what it did before any of this existed.
 */
const reactiveThunkPlan = (
  ctx: EmitContext,
  /** The node the subscription belongs to; removing it releases the subscription. */
  node: string,
  operand: IrOperand,
  admits: (representation: Representation) => boolean = representationCanCell,
  /**
   * Which census names this slot's dependencies. `'value'` -- a text, a prop,
   * a style member, a class entry -- re-runs by writing a value again, so it
   * takes the whole reading. `'node'` re-runs by rebuilding a subtree, which
   * repaints, so it takes the narrowed one: see `ReactiveDependencyCensus`.
   */
  scope: 'value' | 'node' = 'value'
): { readonly thunk: string; readonly origin: IrOperand; readonly subscriptions: readonly string[] } | null => {
  const trace = process.env['GEA_DEBUG_REACTIVE_SLOTS']
    ? (text: string) => process.stderr.write(`reactive slot ${ctx.owner}: ${text}\n`)
    : null
  // The slot's own value first, then each carrier it was converted out of,
  // nearest first: a thunk call whose result lowering converted into the
  // slot's carrier is one `convert` behind the value the slot holds (see
  // `EmitContext.conversionSources`). Nearest first because the predicate
  // is about the SLOT -- a conditional child is admitted as the optional the
  // slot holds, not as the bare node its arm produced.
  let origin: IrOperand | undefined = operand
  let callee: IrValueId | undefined
  let functionId: FunctionId | undefined
  while (origin !== undefined) {
    callee = admits(origin.representation) ? ctx.callCallees.get(origin.value) : undefined
    functionId = callee === undefined ? undefined : ctx.thunkValues.get(callee)
    if (callee !== undefined && functionId !== undefined) break
    origin = ctx.conversionSources.get(origin.value)
  }
  if (origin === undefined || callee === undefined || functionId === undefined) {
    trace?.(`${operand.value} (${operand.representation.kind}): no admitted value in its history is a call of a recorded thunk`)
    return null
  }
  const census = scope === 'node' ? ctx.hosts.reactive.nodeDependencies : ctx.hosts.reactive.dependencies
  const dependencies = census.get(functionId) ?? []
  if (dependencies.length === 0) {
    trace?.(`${operand.value}: thunk ${functionId} reads no reactive cell`)
    return null
  }
  const subscriptions: string[] = []
  for (const dependency of dependencies) {
    const owner = subscriptionOwnerText(ctx, dependency)
    // A dependency whose owner this frame cannot NAME is skipped rather than
    // guessed at: subscribing the wrong object would re-render against
    // somebody else's state, which is worse than not re-rendering. Skipping
    // every one of them leaves an empty list, and the slot then falls through
    // to the once-only path below -- the same stated gap, not a silent
    // half-binding.
    const member = dependency.revision ? cppReactiveRevisionFieldName(dependency.key) : cppRecordFieldName(dependency.key)
    if (owner !== null) {
      subscriptions.push(`gea::jsx::subscribeSignal(${node}, ${owner}, &${dependency.struct}::${member}, gea_apply);`)
    }
  }
  if (subscriptions.length === 0) {
    trace?.(`${operand.value}: thunk ${functionId} has ${dependencies.length} dependencies but none this frame can name`)
    return null
  }
  return { thunk: nameOfValue(ctx, callee), origin, subscriptions }
}

/**
 * The C++ expression this frame names one dependency's owning object by.
 *
 * Two shapes, because those are the two a slot expression uses (see
 * `reactive-dependencies.ts`): the thunk captured the enclosing template's
 * receiver, so `this.count` is subscribed through this frame's own receiver;
 * and a module-scope store has a global cell any frame can reach by name.
 *
 * A boxed binding is refused. `bindingReference` names the BOX for one -- a
 * `std::shared_ptr` to the cell, not the object in it -- and handing that to
 * `subscribeSignal` would deduce `Owner` as the wrong type. It is a real gap
 * (a store captured by a closure that reassigns it), reported by falling
 * through rather than by emitting a binding to the wrong thing.
 */
const subscriptionOwnerText = (ctx: EmitContext, dependency: ReactiveDependency): string | null => {
  if (dependency.source.kind === 'receiver') return ctx.abi?.receiver ? cppReceiverName : null
  const reference = bindingReference(ctx, dependency.source.declaration, 'a reactive subscription')
  return reference.boxed ? null : reference.name
}

const reactiveApplyBlock = (open: string, subscriptions: readonly string[]): readonly string[] => [
  '{',
  `  const auto gea_apply = ${open};`,
  ...subscriptions.map((line) => `  ${line}`),
  '}'
]

/**
 * A LIST child -- `{items.map(item => <Row/>)}` -- as opposed to a single value.
 *
 * The distinction is the child's own carrier and nothing syntactic: an array of
 * anything is appended element by element (`gea::jsx::child`'s array rule), and
 * re-rendering one means taking those elements back down and building them
 * again rather than re-setting one node's text.
 */
const isListChild = (representation: Representation): boolean => representation.kind === 'array-object'

/**
 * A SUBTREE child -- one node, produced by a component invocation -- as opposed
 * to a value rendered as text.
 *
 * `representationCanCell` answers `false` for a host handle (it is neither a
 * scalar nor a string), which is what keeps a node out of the text path below;
 * it is also why a node-valued thunk needs its own predicate rather than the
 * default one.
 */
const isNodeChild = (representation: Representation): boolean => representation.kind === 'native-handle'

/**
 * A CONDITIONAL subtree child -- `{companion.view === 7 && <div class="page"/>}`
 * -- whose value is either one node or nothing.
 *
 * A third node-shaped carrier, distinct from `isNodeChild` and needing its own
 * apply, because "nothing" is a state the program asked for: the subtree has to
 * come DOWN when the condition goes false, which a rule written for a component
 * invocation (whose thunk always produces a node) has no case for.
 *
 * The screen is deliberately exact rather than "a union that mentions a node",
 * because what makes the binding correct is that every OTHER arm renders
 * nothing. `gea::jsx::child`'s own rules are the authority for which those are:
 * a `bool` arm is dropped ("JSX drops a boolean child rather than printing
 * it"), and an absent optional appends nothing. A `string` or number arm is not
 * one of them -- `{name && <Row/>}` over a string really does render the string
 * when it is non-empty -- so such a union falls through to the once-only path
 * rather than being bound to a rule that would silently drop its other half.
 * That is a stated gap, not a refusal, and it is the same gap it was before.
 *
 * Exactly one node arm, for the same reason: two would make "which subtree is
 * on screen" a question the apply cannot answer from a handle alone.
 */
const isOptionalNodeChild = (representation: Representation): boolean => {
  if (representation.kind === 'optional') return representation.payload.kind === 'native-handle'
  if (representation.kind !== 'tagged-union') return false
  let nodes = 0
  for (const arm of representation.arms) {
    const value = arm.value
    if (value.kind === 'native-handle') {
      nodes += 1
      continue
    }
    if (value.kind === 'null' || value.kind === 'undefined' || value.kind === 'void') continue
    if (value.kind === 'scalar' && value.domain === 'boolean') continue
    return false
  }
  return nodes === 1
}

export const emitElementChild = (ctx: EmitContext, lines: string[], operation: ElementChildOperation): void => {
  // Before the single-value path: a list's thunk returns an array, which
  // `representationCanCell` rejects, so it would otherwise fall straight
  // through to the once-only `child` below -- which is exactly the bug this
  // exists to fix (a store's array renders one frame and then never again).
  const list = reactiveThunkPlan(ctx, operandText(ctx, operation.node), operation.child, isListChild, 'node')
  if (list) {
    // The child operand is the array the emitted call already produced; it is
    // handed over so the first render appends it instead of building a second,
    // orphaned copy of every row.
    lines.push(
      ...reactiveApplyBlock(
        `gea::jsx::reactiveListApply(${operandText(ctx, operation.node)}, ${list.thunk}, ${operandText(ctx, operation.child)})`,
        list.subscriptions
      )
    )
    return
  }
  // Before the text path, for the same reason the list is: a component
  // invocation's thunk returns a NODE, and rendering one as text is not a
  // weaker binding, it is a wrong one. `plugins/gea/reactive-slots.ts` claims a
  // component element whose props read reactive state, so the whole invocation
  // -- props record and call -- is one re-runnable unit; what changes when a
  // prop changes is the subtree, so the subtree is replaced.
  const subtree = reactiveThunkPlan(ctx, operandText(ctx, operation.node), operation.child, isNodeChild, 'node')
  if (subtree) {
    lines.push(
      ...reactiveApplyBlock(
        `gea::jsx::reactiveNodeApply(${operandText(ctx, operation.node)}, ${subtree.thunk}, ${operandText(ctx, operation.child)})`,
        subtree.subscriptions
      )
    )
    return
  }
  // And before the text path for the third time, because a conditional's union
  // is neither a node nor a value to render as text. `{view === 7 && <div/>}`
  // is the shape, and what it needs that `reactiveNodeApply` above does not
  // give it is the ABSENT state: the subtree comes down when the condition goes
  // false and returns to its own position when it goes true. Without this it
  // fell through to the once-only `child` below -- the thunk minted, called
  // once, and its value appended as a static child -- so a detail pane rendered
  // whatever the condition held at build time and never switched again.
  const conditional = reactiveThunkPlan(ctx, operandText(ctx, operation.node), operation.child, isOptionalNodeChild, 'node')
  if (conditional) {
    lines.push(
      ...reactiveApplyBlock(
        `gea::jsx::reactiveOptionalNodeApply(${operandText(ctx, operation.node)}, ${conditional.thunk}, ${operandText(ctx, operation.child)})`,
        conditional.subscriptions
      )
    )
    return
  }
  // A text leaf's content is the node's OWN characters. Every spelling below is
  // the same binding the container form uses with the created-and-appended text
  // node removed: there is nothing to create, because lowering already proved
  // this element has exactly one run and the host built the node as that run.
  const leaf = operation.textLeaf
  const computed = reactiveThunkPlan(ctx, operandText(ctx, operation.node), operation.child)
  if (computed) {
    const apply = leaf ? 'reactiveLeafTextApply' : 'reactiveChildApply'
    lines.push(...reactiveApplyBlock(`gea::jsx::${apply}(${operandText(ctx, operation.node)}, ${computed.thunk})`, computed.subscriptions))
    return
  }
  const reactive = reactiveMemberPointer(ctx, operation.child)
  if (reactive) {
    const bind = leaf ? 'reactiveLeafText' : 'reactiveChild'
    lines.push(`gea::jsx::${bind}(${operandText(ctx, operation.node)}, ${reactive.receiver}, ${reactive.member});`)
    return
  }
  if (leaf) {
    lines.push(`gea::jsx::leafText(${operandText(ctx, operation.node)}, ${operandText(ctx, operation.child)});`)
    return
  }
  lines.push(`gea::jsx::child(${operandText(ctx, operation.node)}, ${operandText(ctx, operation.child)});`)
}

/**
 * A once-only `class={{...}}` block, spelled as its own attribute text.
 *
 * The table this replaces exists only to be walked once: `objectProp` joins the
 * truthy keys, sets the attribute and drops it. Every one of those keys is a
 * literal the emitter already holds, so the join is a compile-time question
 * wearing a runtime table's clothes -- a heap `Dictionary` plus one doubly
 * boxed `TaggedUnion` per entry, several of them inside list rows and therefore
 * per row per render.
 *
 * The split is by what each entry's truthiness is KNOWN to be, which is what
 * makes the always-true key free rather than merely cheap:
 *
 *   - a constant-true entry is text, concatenated into the literal prefix;
 *   - a constant-false entry is nothing at all -- it is dropped;
 *   - anything else is one token, tested at run time by `booleanTestText`,
 *     the same authority every other truthiness question in this emitter asks.
 *
 * A block whose entries are all constant therefore renders as `prop(node,
 * "class", "a b")` -- indistinguishable from having been written `class="a b"`,
 * which is what the program meant.
 *
 * Applies only where `emitObjectPropEntries` declined. A reactive entry needs
 * the table to persist so its apply can write back into it, and that path
 * claiming the prop is exactly the signal that it does -- which is why no
 * reactivity question is asked here or in the census.
 */
/**
 * The primitive a value was widened out of, or the value itself.
 *
 * Follows `convert` results back only while the step lands on a scalar or a
 * string: those are the carriers whose truthiness a widening preserves and
 * whose constant-ness `booleanConstants` records. A narrowing out of a box
 * or an optional is not followed -- its source's truthiness is a different
 * question (an absent optional is falsy where its payload may not be).
 */
const primitiveOriginOf = (ctx: EmitContext, operand: IrOperand): IrOperand => {
  let origin = operand
  for (;;) {
    const previous = ctx.conversionSources.get(origin.value)
    if (previous === undefined || !representationCanCell(previous.representation)) return origin
    origin = previous
  }
}

const emitClassTokens = (
  ctx: EmitContext,
  lines: string[],
  operation: ElementPropOperation,
  node: string,
  key: string,
  table: IrValueId
): boolean => {
  const sources = ctx.recordFieldSources.get(operation.value.value)
  if (!sources) return false
  const constant: string[] = []
  const tokens: string[] = []
  for (const [entry, recorded] of sources) {
    // The entry's truthiness is asked of the value BEFORE lowering widened it
    // into the table's declared union: a widening of a primitive keeps its
    // truthiness, and the primitive is where the constant is known and where
    // the test is one comparison rather than a walk over every arm of the
    // union (`EmitContext.conversionSources`).
    const source = primitiveOriginOf(ctx, recorded)
    const known = ctx.booleanConstants.get(source.value)
    if (known === false) continue
    if (known === true) {
      constant.push(entry)
      continue
    }
    tokens.push(`{${cppStringLiteral(entry)}, ${booleanTestText(operandText(ctx, source), source.representation)}}`)
  }
  // The allocation rendered nothing, but `defineValue` hoisted a declaration
  // for it before this decision was reachable. Retract it: an unused local of a
  // `Ref<Dictionary<...>>` type is both an allocation this lowering exists to
  // remove and, under `-Werror`, a build failure.
  const name = ctx.valueNames.get(table)
  const declared = ctx.declarations.findIndex((declaration) => declaration.name === name)
  if (declared >= 0) ctx.declarations.splice(declared, 1)
  const text = cppStringLiteral(constant.join(' '))
  if (tokens.length === 0) {
    lines.push(`gea::jsx::prop(${node}, ${key}, ${text});`)
    return true
  }
  lines.push(`gea::jsx::classTokens(${node}, ${key}, ${text}, {${tokens.join(', ')}});`)
  return true
}

/**
 * The class-map tables this body may spell as a token list instead of building.
 *
 * `class={{ 'city-row': true, 'is-hidden-row': flag }}` derives a
 * `gea::Dictionary` because `ClassMap` is declared with an index signature, and
 * the once-only path then hands that table WHOLE to `objectProp`, which walks
 * it, joins the truthy keys, sets the attribute and drops it. So the table is a
 * heap allocation and one doubly-boxed `TaggedUnion` per entry, built to be
 * read once, by a walk whose every key the emitter already knows -- 19 of them
 * in `examples/apps/weather`, most inside list rows and therefore per row per
 * render.
 *
 * An object literal is not one operation. It is an EMPTY `allocate-record`
 * followed by a `define-own-property` per member, each threading the table
 * onward as its own result -- the same chain `emit-properties.ts` accumulates
 * `recordFieldSources` along, and the reason this census follows a lineage
 * rather than reading `allocate-record.fields`, which for a literal is empty.
 *
 * A chain qualifies when every value in it is read only by the next link, and
 * the last link is read exactly once: by an `element-prop` whose key is the
 * constant `"class"`. Both halves are load bearing. A second reader anywhere
 * would see a table this emitter never built; any other prop has no rule that
 * joins keys. A member whose key is not a constant disqualifies the chain
 * outright -- the emitter cannot spell a key it cannot name.
 *
 * A chain must also live in ONE block. The lines are withheld and replayed at
 * the prop, so a table built under a condition the prop does not share would be
 * moved across that condition -- and one built in a loop, replayed once.
 *
 * Reactive entries are NOT excluded here, and the omission is the design. That
 * question is settled at the prop, where `emitObjectPropEntries` either claims
 * the table -- and the buffer is flushed, table built, nothing lost -- or
 * declines, and it is spelled away. Asking it here as well would mean
 * re-deriving an answer from facts that are not filled until callables render;
 * an earlier revision did exactly that and, being necessarily conservative,
 * excluded all 19 of `weather`'s tables to protect the 3 that bind.
 */
export const classTableRootsOf = (body: IrBody): ReadonlyMap<IrValueId, IrValueId> => {
  const strings = stringConstantsOf(body)
  // Every value that IS some literal table, and which table it is. A store
  // republishes the table as its own result, and different lowerings thread
  // that differently -- each store naming the original, or each naming the one
  // before it -- so membership is by lineage and never by counting links.
  const root = new Map<IrValueId, IrValueId>()
  const members = new Map<IrValueId, Set<IrValueId>>()
  const broken = new Set<IrValueId>()
  const storeSites = new Map<IrValueId, Set<IrOperation>>()
  const propSites = new Map<IrValueId, ElementPropOperation[]>()
  const tableBlocks = new Map<IrValueId, Set<IrBlockId>>()
  const sited = (table: IrValueId, blockId: IrBlockId): void => {
    tableBlocks.set(table, (tableBlocks.get(table) ?? new Set<IrBlockId>()).add(blockId))
  }
  const join = (table: IrValueId, value: IrValueId): void => {
    root.set(value, table)
    members.set(table, (members.get(table) ?? new Set<IrValueId>()).add(value))
  }
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of block.operations) {
      if (operation.kind === 'allocate-record' && operation.result.representation.kind === 'dictionary') {
        join(operation.result.id, operation.result.id)
        sited(operation.result.id, blockId)
        continue
      }
      if (operation.kind === 'define-own-property' || operation.kind === 'set') {
        const table = root.get(operation.receiver.value)
        if (table === undefined) continue
        // A key this compilation cannot name reaches any member, so the chain
        // stops being one the emitter can spell.
        if (strings.get(operation.key.value) === undefined) broken.add(table)
        storeSites.set(table, (storeSites.get(table) ?? new Set<IrOperation>()).add(operation))
        sited(table, blockId)
        if (operation.result !== null) join(table, operation.result.id)
        continue
      }
      if (operation.kind === 'element-prop' && strings.get(operation.key.value) === 'class') {
        const table = root.get(operation.value.value)
        if (table === undefined) continue
        propSites.set(table, [...(propSites.get(table) ?? []), operation])
        sited(table, blockId)
      }
    }
  }
  // Every reader of every value in a chain, so a table that reaches anything
  // but its own stores and its one class prop is left alone. Terminators are
  // walked as well -- a table that escapes through a `return` or is thrown has
  // a reader this body cannot see -- and are spelled out because `ir/queries.ts`
  // has no operand helper for them.
  const escaped = new Set<IrValueId>()
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of block.operations) {
      for (const operand of operandsOfIrOperation(operation)) {
        const table = root.get(operand.value)
        if (table === undefined) continue
        const stores = storeSites.get(table)
        const props = propSites.get(table) ?? []
        const accounted = (stores !== undefined && stores.has(operation)) || props.some((prop) => prop === operation)
        if (!accounted) escaped.add(table)
      }
    }
    const terminator = block.terminator
    const carried =
      terminator.kind === 'return'
        ? terminator.value
        : terminator.kind === 'throw'
          ? terminator.value
          : terminator.kind === 'branch'
            ? terminator.condition
            : terminator.kind === 'switch'
              ? terminator.discriminant
              : null
    const mentions = [
      ...(carried === null ? [] : [carried]),
      ...(terminator.kind === 'switch' ? terminator.cases.map((one) => one.test) : [])
    ]
    for (const operand of mentions) {
      const table = root.get(operand.value)
      if (table !== undefined) escaped.add(table)
    }
  }
  const spelled = new Map<IrValueId, IrValueId>()
  for (const [table, values] of members) {
    if (broken.has(table) || escaped.has(table)) continue
    if ((propSites.get(table) ?? []).length !== 1) continue
    if ((tableBlocks.get(table) ?? new Set<IrBlockId>()).size !== 1) continue
    for (const value of values) spelled.set(value, table)
  }
  return spelled
}
