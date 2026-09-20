import type { SemanticResultId } from '../../identity/ids.js'
import type { SemanticGraph } from '../../semantics/model/graph.js'
import { operandOf, type SemanticOperand } from '../../semantics/model/operands.js'
import type { ElementOperation, SemanticOperation } from '../../semantics/model/operations.js'

/**
 * Splits a component's `template()` element tree into static structure and
 * dynamic slots, from the compiler's own semantic graph rather than from a
 * Babel AST.
 *
 * gea's real build tool (`packages/vite-plugin-gea/src/closure-codegen/`)
 * does this exact split -- `walkJsxToTemplate` produces a `TemplateSpec
 * {html, slots}`, and `GeaIrSlot` is `{index, kind, walk, walkKinds?, expr?,
 * payload?}`. This module produces the same shape for the same reason gea
 * does: a reactive renderer needs to know, ahead of any render, which DOM
 * positions never change (bake them into a template) and which ones do
 * (patch only those). But gea's `expr` is a *generated code string* --
 * `generate(expr).code` -- and that is exactly what this architecture
 * forbids: generated text is never authority here. A slot below cites the
 * `SemanticOperand` that produces its value (which, when its source is a
 * published result, already carries the `SemanticResultId` a consumer needs)
 * so a later stage resolves it through the ordinary typed operand machinery
 * instead of re-parsing a string this analysis would otherwise have invented.
 *
 * This is pure analysis: no lowering, no emission, no mutation of the graph
 * it reads. Someone else (unwritten as of this file) consumes the result to
 * decide how to actually build and patch DOM.
 */

/** One static attribute: a name and the constant value baked into the template. */
export interface StaticAttribute {
  readonly name: string
  readonly value: string
}

/** A text run that never changes -- baked into the template verbatim. */
export interface StaticTextChild {
  readonly kind: 'text'
  readonly text: string
}

/**
 * A child position occupied by a dynamic slot. This node carries no value of
 * its own -- `slotIndex` is a pointer into the sibling `slots` array, which is
 * where the value (and the operand that produces it) actually lives. Keeping
 * the anchor separate from the slot mirrors gea's own split between the
 * template HTML (which has a bare `<!--N-->` comment at this position) and
 * `TemplateSpec.slots` (which has the slot's behavior) -- except this analysis
 * has no HTML to put the marker in, so the anchor node stands in its place.
 */
export interface SlotAnchorChild {
  readonly kind: 'anchor'
  readonly slotIndex: number
}

export type StaticChild = StaticElement | StaticTextChild | SlotAnchorChild

/** A static intrinsic element: a fixed tag, with its own mix of static and dynamic content. */
export interface StaticElement {
  readonly kind: 'element'
  readonly tag: string
  readonly attributes: readonly StaticAttribute[]
  readonly children: readonly StaticChild[]
}

/**
 * One step of a `walk`, element-aware.
 *
 * `{elem: N}` means "the N-th element among this level's siblings" (every
 * static-element and dynamic-text/mount position counts toward sibling order,
 * but only elements advance N); `{child: N}` means "the N-th child of any
 * kind," which is what a comment-marker or text-node position needs since it
 * is not itself an element. This is the same distinction gea's `walkKinds`
 * draws, kept alongside the plain index-path `walk` for the same reason gea
 * keeps both: `walk` is what every consumer needs at minimum, `walkKinds` is
 * what lets one use `firstElementChild`/`nextElementSibling` chains instead of
 * `childNodes[i]` indexing when it wants to.
 */
export type WalkStep = { readonly elem: number } | { readonly child: number }

/**
 * Attribute-slot kinds -- what a dynamic attribute *does* when it changes.
 *
 * This vocabulary ('class' writes className, 'style' writes a
 * CSSStyleDeclaration, an event name wires a listener rather than writing a
 * property at all) is not a fact about JSX or about this compiler's semantic
 * graph: it is gea's own policy for what its attribute names mean, and a
 * different library rendering through the same element operations is free to
 * classify them differently. That is exactly why `classifyAttrKind` below
 * lives in this file, behind the plugin boundary, instead of in
 * `src/semantics/` where it would silently become every framework's answer.
 */
export type AttributeSlotKind = 'event' | 'class' | 'style' | 'value' | 'bool' | 'ref' | 'html' | 'attr'

/** Every slot kind: the attribute kinds above, plus a reactive text child and a mounted component. */
export type TemplateSlotKind = AttributeSlotKind | 'text' | 'mount'

/**
 * One dynamic position in the tree.
 *
 * `walk`/`walkKinds` locate the position from the template root -- see the
 * module doc comment above for why every slot's walk must be captured
 * *before* any of them act: this analysis never acts on anything, but a
 * consumer that does (mounting a component, materializing a conditional
 * branch, splicing in a list) mutates the live parent's child list when it
 * does, and a walk computed against the pristine tree is only valid if it is
 * captured before that mutation runs. gea's own emitter states this exact
 * rule in `compileJsxToBlock` (`emit/emit-core.ts`): "hoist ALL walk captures
 * ... before any slot action runs, because slot actions ... mutate the
 * parent's childNodes list and would shift literal-index walks for subsequent
 * slots." A consumer of this module's output must hoist the same way gea's
 * emitter does; this module simply hands it every walk up front so there is
 * nothing left to compute mid-mutation.
 *
 * `operand` is the citation, never a generated string: it is the exact
 * `SemanticOperand` (attribute prop-value or element child) whose evaluation
 * produces this slot's value, so a consumer reads its `.source`/`.type`
 * through the ordinary typed operand machinery rather than through text this
 * analysis would have had to generate and the consumer would have had to
 * re-parse.
 */
export interface TemplateSlot {
  readonly index: number
  readonly kind: TemplateSlotKind
  readonly walk: readonly number[]
  readonly walkKinds: readonly WalkStep[]
  /** The attribute name, for an attribute-kind slot; `null` for 'text' and 'mount'. */
  readonly attributeName: string | null
  readonly operand: SemanticOperand
}

/**
 * The outcome of analyzing one template root.
 *
 * `blocked` is a first-class answer, not an exception: every construct this
 * analysis cannot describe faithfully (a spread, a fragment root, a
 * conditional or list child whose branches are elements) is refused with a
 * stated reason instead of guessed at. A caller that wants a partial answer
 * for a partially-describable tree is asking this analysis to invent
 * authority for the part it could not prove, which is the one thing it must
 * never do.
 */
export type TemplateAnalysisResult =
  | { readonly kind: 'ok'; readonly root: StaticElement; readonly slots: readonly TemplateSlot[] }
  | { readonly kind: 'blocked'; readonly reason: string }

/**
 * Split a component's template root into static structure and dynamic slots.
 *
 * `root` must be the `ElementOperation` a `template()` body's JSX evaluates to
 * -- the caller is the one that knows which operation that is (it resolved the
 * component's render member and found the operation its body publishes); this
 * function only knows how to walk one, given the graph it belongs to.
 */
export const analyzeTemplate = (root: ElementOperation, graph: SemanticGraph): TemplateAnalysisResult => {
  // A fragment has no single element to anchor a childNodes-index walk on --
  // gea handles this by wrapping the whole thing in a synthetic
  // `<span style="display:contents">`, which is a real DOM decision (an extra
  // node, a real style) that belongs to whoever builds DOM, not to an
  // analysis that only describes what the program wrote. A bare component
  // root (`template() { return <Other/> }`) has the identical problem for the
  // identical reason: there is no host element in the program's own JSX for
  // this analysis to describe as the root, only a mount. Both are refused
  // rather than silently fabricating the wrapper gea would insert.
  if (root.form !== 'intrinsic') {
    return {
      kind: 'blocked',
      reason:
        `the template root is a "${root.form}" element, not an intrinsic one; this analysis anchors every slot's walk on a ` +
        "single host element in the program's own JSX and refuses to fabricate a wrapper for a root that has none"
    }
  }
  const slots: TemplateSlot[] = []
  const built = buildStaticElement(root, graph, slots, [], [])
  if (built.kind === 'blocked') return built
  return { kind: 'ok', root: built.element, slots }
}

/** The operation that published `resultId`, or `null` when the graph has no producer for it (an upstream census block). */
const producingOperation = (graph: SemanticGraph, resultId: SemanticResultId): SemanticOperation | null => {
  const owner = graph.results.get(resultId)
  if (owner === undefined) return null
  return graph.operations.get(owner) ?? null
}

/** The operation an operand's value comes from, or `null` when the operand is not a `result` citation. */
const operandProducer = (graph: SemanticGraph, operand: SemanticOperand): SemanticOperation | null =>
  operand.source.kind === 'result' ? producingOperation(graph, operand.source.result) : null

/**
 * Whether `operand` is JSX-shaped or an absent literal -- the same test
 * gea's `isJsxOrNullish` applies to a ternary/logical branch to decide
 * whether the whole expression is a *conditional element slot* rather than an
 * ordinary reactive value. An element-family operand is a real JSX
 * construction (an intrinsic, a component mount, or even a fragment -- any of
 * which needs a branch-specific sub-template this analysis does not build);
 * `null` and `undefined` are the other branches a program commonly writes for
 * "render nothing."
 * Both absent values are read from the operand's own literal form rather than
 * from its text, because the string `'null'` spells itself exactly the way the
 * language's `null` does.
 */
const isJsxOrNullish = (graph: SemanticGraph, operand: SemanticOperand): boolean => {
  if (operand.source.kind === 'constant') return operand.source.literal === 'null' || operand.source.literal === 'undefined'
  const producer = operandProducer(graph, operand)
  return producer !== null && producer.family === 'element'
}

/**
 * Whether `operand`'s own checked type is an array.
 *
 * This is how a list child is recognized -- not by looking for a `.map()`
 * call, which is a syntax shape this compiler's architecture deliberately
 * does not carry as identity (an `InvocationOperation` records *that* a call
 * happened and what its target proof is, never a method name to pattern-match
 * against). An array-typed value cannot occupy a single reactive DOM
 * position no matter how it was produced -- `.map()`, `.filter()`, a plain
 * array literal, a getter -- so reading the operand's own structural type is
 * both simpler and more complete than trying to special-case one spelling of
 * "produces an array."
 */
const isArrayTyped = (graph: SemanticGraph, operand: SemanticOperand): boolean => {
  const structuralType = graph.structuralTypes.get(operand.type)
  return structuralType !== undefined && structuralType.shape.kind === 'array'
}

/** How one child position resolves, before it becomes a `StaticChild` or a `TemplateSlot`. */
type ChildClassification =
  | { readonly kind: 'static-text'; readonly text: string }
  | { readonly kind: 'static-element'; readonly operation: ElementOperation }
  | { readonly kind: 'mount'; readonly operation: ElementOperation }
  | { readonly kind: 'dynamic-text' }
  | { readonly kind: 'refuse'; readonly reason: string }

/**
 * Classify one child position. A dynamic position is any operand whose source
 * is not `constant` -- constant text is static, everything else needs a
 * closer look at what actually produces it before this analysis can say
 * whether it is describable at all.
 */
const classifyChild = (graph: SemanticGraph, operand: SemanticOperand): ChildClassification => {
  if (operand.source.kind === 'constant') return { kind: 'static-text', text: operand.source.text }
  if (operand.source.kind !== 'result') {
    return {
      kind: 'refuse',
      reason: `a child operand of source kind "${operand.source.kind}" names no value this analysis can place in the tree`
    }
  }
  const producer = producingOperation(graph, operand.source.result)
  if (producer === null) {
    return {
      kind: 'refuse',
      reason: 'the child result has no producing operation in the graph, which means an upstream producer blocked it'
    }
  }
  if (producer.family === 'element') {
    // A spread child (`{...children}`) is already refused at the census level
    // -- `childrenOf` in semantics/normalize/producers/jsx.ts blocks it before
    // an operation ever publishes -- so it never reaches here as a citable
    // result; only a fragment child needs handling of its own.
    if (producer.form === 'fragment') {
      return {
        kind: 'refuse',
        reason:
          "a fragment child splices its own children into the parent's walk at the same depth, which needs renumbering every " +
          'sibling walk after it; this analysis does not perform that renumbering'
      }
    }
    return producer.form === 'intrinsic' ? { kind: 'static-element', operation: producer } : { kind: 'mount', operation: producer }
  }
  if (isArrayTyped(graph, operand)) {
    return { kind: 'refuse', reason: 'an array-typed child needs per-item keyed reconciliation, which this analysis does not build' }
  }
  // A ternary in child position is only a *conditional element* -- the shape
  // this analysis refuses -- when at least one branch is itself JSX (or the
  // `null` a program writes for "nothing"). `cond ? 'a' : 'b'` is an ordinary
  // computed string and is left as a ordinary reactive text slot below,
  // exactly as gea's own `isJsxOrNullish` gate distinguishes the two.
  if (producer.family === 'computation' && producer.form === 'conditional') {
    const consequent = operandOf(producer, 'consequent')
    const alternate = operandOf(producer, 'alternate')
    const branchIsElement =
      (consequent !== undefined && isJsxOrNullish(graph, consequent)) || (alternate !== undefined && isJsxOrNullish(graph, alternate))
    if (branchIsElement) {
      return {
        kind: 'refuse',
        reason: 'a conditional child with an element branch needs branch-specific sub-templates this analysis does not build'
      }
    }
  }
  // Same distinction for `cond && <X/>` / `cond && items.map(...)`: only the
  // right-hand branch matters (the left is the guard, never itself rendered),
  // and it is refused only when that branch is an element or a list.
  if (producer.family === 'computation' && producer.form === 'logical') {
    const right = operandOf(producer, 'right')
    const guardsElementOrList = right !== undefined && (isJsxOrNullish(graph, right) || isArrayTyped(graph, right))
    if (guardsElementOrList) {
      return {
        kind: 'refuse',
        reason:
          'a short-circuit child guarding an element or list branch needs a conditional/list sub-template this analysis does not build'
      }
    }
  }
  return { kind: 'dynamic-text' }
}

/** The result of building one static element subtree: the element itself, or why it could not be built. */
type StaticElementBuild = { readonly kind: 'ok'; readonly element: StaticElement } | { readonly kind: 'blocked'; readonly reason: string }

/**
 * Build one static element node, recording every dynamic slot it or its
 * static-element descendants own into `slots` (mutated in place -- this is
 * the function's own scratch accumulator, not anything the caller handed in,
 * so it stays consistent with "no mutation of anything given").
 *
 * Called only with `operation.form === 'intrinsic'`: `analyzeTemplate` checks
 * the root before the first call, and `classifyChild` only ever routes a
 * *recursive* call here for a child it classified `'static-element'`, which
 * by construction is the `form === 'intrinsic'` branch.
 *
 * Attributes are recorded before children, and children are walked in source
 * order with a nested static element's own attributes and children recorded
 * immediately on recursion -- so slot `index` assignment is a plain pre-order
 * walk of the tree, exactly matching the order gea's `emitElement` visits an
 * element's attributes then its children.
 */
const buildStaticElement = (
  operation: ElementOperation,
  graph: SemanticGraph,
  slots: TemplateSlot[],
  walk: readonly number[],
  walkKinds: readonly WalkStep[]
): StaticElementBuild => {
  const tagOperand = operandOf(operation, 'tag', 0)
  if (tagOperand === undefined || tagOperand.source.kind !== 'constant') {
    return { kind: 'blocked', reason: 'an intrinsic element with no constant tag operand is not one this analysis can name statically' }
  }
  const attributes: StaticAttribute[] = []
  const propKeys = operation.operands.filter((candidate) => candidate.role === 'prop-key').sort((a, b) => a.ordinal - b.ordinal)
  for (const keyOperand of propKeys) {
    if (keyOperand.source.kind !== 'constant') {
      return { kind: 'blocked', reason: 'a computed attribute key is not one this analysis can name statically' }
    }
    const valueOperand = operandOf(operation, 'prop-value', keyOperand.ordinal)
    if (valueOperand === undefined) {
      return { kind: 'blocked', reason: `attribute "${keyOperand.source.text}" has no paired value operand` }
    }
    if (valueOperand.source.kind === 'constant') {
      attributes.push({ name: keyOperand.source.text, value: valueOperand.source.text })
      continue
    }
    if (valueOperand.source.kind !== 'result') {
      return {
        kind: 'blocked',
        reason: `attribute "${keyOperand.source.text}" has a value of source kind "${valueOperand.source.kind}", which this analysis does not describe`
      }
    }
    slots.push({
      index: slots.length,
      kind: classifyAttrKind(keyOperand.source.text),
      walk: [...walk],
      walkKinds: [...walkKinds],
      attributeName: keyOperand.source.text,
      operand: valueOperand
    })
  }
  const children: StaticChild[] = []
  const childOperands = operation.operands.filter((candidate) => candidate.role === 'child').sort((a, b) => a.ordinal - b.ordinal)
  let childIndex = 0
  let elementIndex = 0
  for (const childOperand of childOperands) {
    const classification = classifyChild(graph, childOperand)
    if (classification.kind === 'refuse') return { kind: 'blocked', reason: classification.reason }
    if (classification.kind === 'static-text') {
      // A text node is a real childNodes entry but never an element, so it
      // advances childIndex for any slot that follows it without advancing
      // elementIndex.
      children.push({ kind: 'text', text: classification.text })
      childIndex += 1
      continue
    }
    const childWalk = [...walk, childIndex]
    if (classification.kind === 'static-element') {
      const nested = buildStaticElement(classification.operation, graph, slots, childWalk, [...walkKinds, { elem: elementIndex }])
      if (nested.kind === 'blocked') return nested
      children.push(nested.element)
      elementIndex += 1
      childIndex += 1
      continue
    }
    // 'mount' and 'dynamic-text' both occupy a non-element childNodes
    // position (a mounted component has no element of its own in *this*
    // template -- its own template is a separate analysis the caller runs on
    // its own root), so both advance childIndex but not elementIndex, and
    // both record `{child: childIndex}` as their final walkKinds step.
    slots.push({
      index: slots.length,
      kind: classification.kind === 'mount' ? 'mount' : 'text',
      walk: childWalk,
      walkKinds: [...walkKinds, { child: childIndex }],
      attributeName: null,
      operand: childOperand
    })
    children.push({ kind: 'anchor', slotIndex: slots.length - 1 })
    childIndex += 1
  }
  return { kind: 'ok', element: { kind: 'element', tag: tagOperand.source.text, attributes, children } }
}

/**
 * gea's own DOM event vocabulary (`packages/vite-plugin-gea/src/utils/events.ts`,
 * `EVENT_NAMES`): bare event names a program may write directly (`click`,
 * `input`, ...) as well as the conventional `on*` prefix form. This table,
 * like `classifyAttrKind` itself, is library policy -- a fact about what gea
 * chose to call its events, not a fact this compiler's semantic graph states.
 */
const EVENT_ATTRIBUTE_NAMES = new Set([
  'click',
  'dblclick',
  'mousedown',
  'mouseup',
  'mouseover',
  'mouseout',
  'mousemove',
  'mouseenter',
  'mouseleave',
  'contextmenu',
  'keydown',
  'keyup',
  'keypress',
  'focus',
  'blur',
  'input',
  'change',
  'submit',
  'scroll',
  'touchstart',
  'touchmove',
  'touchend',
  'tap',
  'longTap',
  'swipeRight',
  'swipeUp',
  'swipeLeft',
  'swipeDown',
  'drag',
  'dragstart',
  'dragend',
  'dragover',
  'dragleave',
  'drop',
  'pointerdown',
  'pointerup',
  'pointermove',
  'pointerenter',
  'pointerleave',
  'pointerover',
  'pointerout',
  'pointercancel',
  'resize',
  'reset',
  'wheel',
  'animationstart',
  'animationend',
  'animationiteration',
  'transitionstart',
  'transitionend',
  'transitionrun',
  'transitioncancel'
])

/** Attribute names gea reflects as an IDL boolean property rather than a string attribute. */
const BOOLEAN_ATTRIBUTE_NAMES = new Set([
  'disabled',
  'checked',
  'readonly',
  'readOnly',
  'hidden',
  'required',
  'autofocus',
  'multiple',
  'selected',
  'open',
  'indeterminate',
  'contenteditable',
  'contentEditable'
])

/**
 * gea's attribute-name -> slot-kind table (mirrors `classifyAttrKind` in
 * `packages/vite-plugin-gea/src/closure-codegen/generator/generator-attrs.ts`).
 * See the `AttributeSlotKind` doc comment above for why this policy belongs
 * in this file rather than in the core.
 */
const classifyAttrKind = (name: string): AttributeSlotKind => {
  if (EVENT_ATTRIBUTE_NAMES.has(name)) return 'event'
  if (name.startsWith('on') && name.length > 2) return 'event'
  if (name === 'class' || name === 'className') return 'class'
  if (name === 'style') return 'style'
  if (name === 'value') return 'value'
  if (name === 'visible') return 'bool'
  if (name === 'ref') return 'ref'
  if (name === 'dangerouslySetInnerHTML') return 'html'
  if (BOOLEAN_ATTRIBUTE_NAMES.has(name)) return 'bool'
  return 'attr'
}
