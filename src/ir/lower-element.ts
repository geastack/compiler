import { operandOf } from '../semantics/model/operands.js'
import type { ElementOperation as SemanticElementOperation } from '../semantics/model/operations.js'
import { IrLoweringBlockedError } from './lower-graph.js'
import {
  orderedOperandsOf,
  registerResult,
  requireLineage,
  requireResultRepresentation,
  resolveOptionalOperand,
  resolveRequiredOperand,
  type LoweringContext,
  enterRequiredOperand
} from './lower-operands.js'
import type { PluginInstance } from '../plugins/model.js'
import type { IrBlockId, IrOperand } from './model.js'

/**
 * JSX element construction, lowered as far as the language itself states it.
 *
 * TypeScript gives an intrinsic element a meaning of its own: `JSX.IntrinsicElements`
 * names the tag, the attributes are checked against that declaration, and the
 * children are ordinary expressions. So an intrinsic element lowers here, to a
 * host node followed by its properties and its children -- one step at a time,
 * because there is no props object in the language for it and inventing one in
 * the IR would be a claim the source never made.
 *
 * A tag that names a *value* is where the language stops. The checker resolves
 * a call or a construct signature, but what happens afterwards -- whether the
 * result is invoked once, instantiated and re-entered on a later frame, or
 * compiled into a static structure with patched positions -- is a library's
 * meaning, not TypeScript's. A compiler that picked one would be picking a
 * framework. So this file refuses that form, and a plugin claims it: see
 * `src/plugins/model.ts` for the seam and `src/plugins/gea/` for the claim
 * that gea's component model actually makes.
 *
 * A JSX element's props are ordered pairs in the semantic graph -- `prop-key`
 * and `prop-value` at the same ordinal -- and they have to stay paired here.
 * Reading the two roles independently and zipping by position would silently
 * pair a key with the wrong value the moment one of them is absent.
 */

export const lowerElement = (
  ctx: LoweringContext,
  block: IrBlockId,
  operation: SemanticElementOperation,
  plugins: readonly PluginInstance[] = []
): void => {
  const lineage = requireLineage(operation)
  const keys = orderedOperandsOf(operation, 'prop-key')
  const children = orderedOperandsOf(operation, 'child').map((child) => enterRequiredOperand(ctx, block, lineage, operation, child))
  const tag = resolveOptionalOperand(ctx, block, lineage, operandOf(operation, 'tag', 0))
  const representation = requireResultRepresentation(ctx, operation, 'value', 'an element construction')
  // A fragment is not the same refusal. `<>...</>` is JSX's own form, not a tag
  // naming somebody's value: it creates a node, takes children, and takes no
  // props -- the identical three steps below, with nothing about them for a
  // library to decide. What a fragment *builds* is still the host's answer, and
  // that is asked at emission (`PluginCapabilities.elementFragment`), where the
  // host's spelling lives; refusing it here would refuse it in a layer that
  // has no host to ask.
  if (operation.form === 'value') {
    throw new IrLoweringBlockedError(
      "this element's tag names a value rather than an intrinsic the language declares; " +
        "what such an element means at runtime is a library's, and no installed plugin claimed it"
    )
  }
  // Create first, then decorate. The node has to exist before anything can be
  // put on it, and writing that as three steps rather than one bundled
  // operation is what leaves room for a consumer to act on the node between
  // them -- attaching a nested component into it, or holding on to it so a
  // later update can find it again.
  // One decision, read by the create and by the child alike: whether the node
  // this element builds IS its text (`isTextLeaf` below).
  const textLeaf = isTextLeaf(operation, children, plugins)
  const node = ctx.builder.element(block, lineage, operation.form, tag, representation, textLeaf)
  const nodeOperand: IrOperand = { value: node, representation }
  for (const key of keys) {
    const value = operandOf(operation, 'prop-value', key.ordinal)
    if (!value) throw new IrLoweringBlockedError(`an element property at ordinal ${key.ordinal} names a key with no value operand`)
    // Offered to the plugins first, and only for this one prop. A name like
    // JSX's `ref` is not a property of the node -- it says where to PUT the
    // node -- and which names mean that is the library's to say, not this
    // file's. A prop nobody claims takes the same path it always did.
    if (plugins.some((plugin) => plugin.lowerElementProp?.(ctx, block, lineage, nodeOperand, key, value) === true)) continue
    ctx.builder.elementProp(
      block,
      lineage,
      nodeOperand,
      resolveRequiredOperand(ctx, block, lineage, key),
      enterRequiredOperand(ctx, block, lineage, operation, value)
    )
  }
  for (const child of children) ctx.builder.elementChild(block, lineage, nodeOperand, child, textLeaf)
  registerResult(ctx, operation, node)
}

/**
 * Whether this element IS its text rather than containing it.
 *
 * Two authorities, and both have to say yes. The host names the tags its node
 * model has a text node for (`PluginCapabilities.elementTextTags`) -- gea's
 * engine has one whose class and style behave exactly as an element's do, so a
 * `<span>` holding only characters is that node and a `<div>` never is. The
 * language then says whether THIS element's contents are a single text run,
 * which is what the children's carriers already state: a nested element is a
 * host handle, a list is an array, a conditional child is a union, and none of
 * those is text.
 *
 * Both halves are v1's, split the same way: `isTextNodeTag` is the tag list,
 * and `canUseTextNodeForElement` is the contents rule -- no element children,
 * exactly one run. Its own comment records what taught them the multi-run case:
 * a text node holds ONE run, so baking one run into the parent and appending
 * the rest as children stacks them all at the parent's origin, and `<span>{a} /
 * {b}</span>` renders as one garbled glyph.
 *
 * Everything not proven is a container. A tag this frame cannot read as a
 * literal, a child whose carrier is anything but characters, an element with no
 * children or with several -- all take the path every element took before this
 * existed. That asymmetry is deliberate: a container one level deeper than v1's
 * is visible and fails loudly, while an element flattened when it should not be
 * is a silently wrong tree.
 */
const isTextLeaf = (operation: SemanticElementOperation, children: readonly IrOperand[], plugins: readonly PluginInstance[]): boolean => {
  if (operation.form !== 'intrinsic') return false
  const child = children.length === 1 ? children[0] : undefined
  // A run is characters: a string, or a number/boolean the host renders as
  // one. Every other carrier -- a node, an array of nodes, a union that may be
  // either -- is content this element contains rather than content it is.
  if (!child || (child.representation.kind !== 'string' && child.representation.kind !== 'scalar')) return false
  const source = operandOf(operation, 'tag', 0)?.source
  if (source?.kind !== 'constant' || source.literal !== 'string') return false
  const tag = source.text.toLowerCase()
  return plugins.some((plugin) => plugin.capabilities.elementTextTags.includes(tag))
}
