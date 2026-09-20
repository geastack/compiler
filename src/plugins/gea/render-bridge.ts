import type { DeclarationId, FunctionId } from '../../identity/ids.js'
import { operationOfResult } from '../../identity/ids.js'
import { operandOf, type SemanticOperand } from '../../semantics/model/operands.js'
import type { SemanticOperation } from '../../semantics/model/operations.js'
import { IrLoweringBlockedError } from '../../ir/lower-graph.js'
import { namedOperand, registerResult, requireLineage, resolveRequiredOperand, type LoweringContext } from '../../ir/lower-operands.js'
import type { IrBlockId } from '../../ir/model.js'
import { geaAfterRenderMemberName, geaMountedElementMemberName, geaRenderBridgeMemberName, geaRenderMemberName } from './contract.js'

/**
 * `primitives.ts`'s mount-time bridge, ported rather than redesigned.
 *
 * v1 shares this repo's *same* `@geastack/core` runtime with v2 -- the same
 * `Component`/`mount()` (`core/packages/core/index.d.ts:610-613`,
 * `core/packages/core/runtime/primitives.ts:11-25`) -- so `render` is not a
 * declared TypeScript member in v1 either; `mount()`'s structural cast is
 * the identical escape hatch in both compilers, not a v2-specific gap. What
 * v1 does about it is `cpp-source-replacements.ts`'s
 * `insertComponentBridgeMethods` (that file's lines 76-117): a narrow,
 * *textual* post-processing pass over already-emitted C++, entirely outside
 * geatsc's semantic/IR pipeline, that adds a natively-typed `render`/
 * `dispose` pair to a class that also got a "mounted renderer" (a template
 * compiled to a standalone C++ function -- `cpp-template-renderer.ts`'s
 * `templateMountedRenderer`, line 126). The convention it writes -- one
 * parameter for the mount parent, a second, always-unused `_index`
 * (`(void)_index;`, line 100), calling the compiled template and attaching
 * what it returns under the parent -- is v1's real, native answer to "what
 * does a render bridge do", ported here rather than redesigned
 * (`citations.md` section 1). v1's own version boxes every part of it
 * (`gea_cpp_value parent`, `gea_cpp_value _index`, `gea_cpp_value el`,
 * lines 96-99) -- the repo-wide "No Boxing" rule this port follows instead
 * is what makes `root` a real native handle here and drops `el`/`dispose`
 * rather than reaching for the same box.
 *
 * v2 has no external base-swap tool, and `Component` (`compiler.ts`) is
 * deliberately left without a `render` method of its own -- declaring one
 * there breaks embedded codegen (its own comment). So there is no ordinary
 * declaration for this member anywhere in a v2 program: `render` is a name
 * `mount()`'s own structural cast spells (`geaRenderBridgeMemberName`), never
 * a method any class writes. `unwrapErased` still resolves the cast's
 * receiver to the real, monomorphized component class -- so the read is a
 * real "get" of a real class instance, on a member that plainly is not one of
 * its fields, accessors, or methods, which is exactly the refusal this ports
 * v1's answer to close.
 *
 * The fix recognizes the one call shape `mount()`'s cast produces --
 * `instance.render(root, depth)` on an instance of a class this file's sibling
 * `component-classes.ts` has already told gea is one of its own -- and
 * rebuilds it as what it means: call the class's own `template` member (the
 * same member and the same calling convention `lower.ts`'s `lowerClassComponent`
 * already calls for a JSX-constructed child of this class), then attach what
 * it returns under `root`. `depth` is read nowhere in v1's own body either
 * (`(void)_index;`, `cpp-source-replacements.ts:113`) and is dropped here the
 * same way.
 *
 * `el` is written, natively. v1 boxes it (`gea_cpp_value el`) because its
 * bridge is a textual pass with no type in hand; here the field is a real
 * member of the component's struct -- `component-classes.ts` publishes the
 * `define-field` event `Component`'s ambient body never did -- and the node
 * goes in as the host handle it already is. That matters beyond tidiness: six
 * corpus apps (`bubble-grid`, `canvas-3d-cube`, `e-reader`, `image-demo`,
 * `maps`, `ttf-bench`) do all of their work from `onAfterRender()`, and every
 * one of them guards on `this.el` before doing any of it.
 *
 * `onAfterRender` is then called, because otherwise nothing calls it: the hook
 * is a method no other code reaches, so the emitter -- correctly -- emits
 * nothing for it, and the app compiles clean, links clean, and draws nothing.
 * `bubble-grid` did exactly that. The framework's own JS component runtime ends
 * its `render` with the same two steps, and v1 gets them by keeping that
 * runtime whole for any component declaring a lifecycle member
 * (`geatsc-plugin-gea/src/index.ts`'s `componentHasRuntimeLifecycle`); this
 * bridge performs them directly instead, which is the same behaviour without
 * the boxed runtime.
 *
 * `dispose` is still not allocated. `mount()` is fire-and-forget -- no corpus
 * program calls `.dispose()` on a mounted root -- and a disposer whose only
 * caller does not exist would be storage nothing ever reads.
 */

/**
 * The `FunctionId` that calls a class's own `template` member, or `null` when
 * it declares none of its own.
 *
 * An inherited `template` is a gap this shares with `lower.ts`'s
 * `lowerClassComponent`, not a new one: that lowering already refuses "a
 * render inherited from a base is entered through the base that declares it,
 * which this lowering does not yet resolve", and a class this bridge cannot
 * find an own member for is refused the same honest way -- by declining to
 * redirect it, leaving the core's ordinary "not a field, accessor, or method"
 * refusal to name the gap.
 */
const templateCallableOf = (ctx: LoweringContext, declaration: DeclarationId): FunctionId | null => {
  const layout = ctx.program.classes.get(declaration)
  const member = layout?.methods.find((method) => method.key === geaRenderMemberName)
  return member?.callable ?? null
}

/**
 * A method of this class or of any class it derives from, by key.
 *
 * A lifecycle hook is written wherever the author put it -- a shared base that
 * several screens extend is the ordinary way to write one -- and a lookup that
 * stopped at the class's own members would silently skip the hook rather than
 * refuse it. The walk is the same one `classMemberOf` performs for an ordinary
 * inherited member: own members first, then the base, so an override wins.
 */
const inheritedMethodOf = (ctx: LoweringContext, declaration: DeclarationId, key: string): FunctionId | null => {
  let current: DeclarationId | null = declaration
  const seen = new Set<DeclarationId>()
  while (current !== null && !seen.has(current)) {
    seen.add(current)
    const layout = ctx.program.classes.get(current)
    if (!layout) return null
    const member = layout.methods.find((method) => method.key === key)
    if (member) return member.callable
    current = layout.base
  }
  return null
}

/**
 * Whether this class -- or a base -- really has storage for `el`.
 *
 * `component-classes.ts` publishes the field for every class it recognizes as
 * one of gea's, so this is normally true; it is asked rather than assumed
 * because a class whose layout does not carry the member has nowhere to put the
 * node, and writing one anyway would emit a struct member reference that does
 * not exist. Answering `false` leaves the tree attached and the hook uncalled,
 * which is what this bridge did before the field existed at all.
 */
const hasMountedElementField = (ctx: LoweringContext, declaration: DeclarationId): boolean => {
  let current: DeclarationId | null = declaration
  const seen = new Set<DeclarationId>()
  while (current !== null && !seen.has(current)) {
    seen.add(current)
    const layout = ctx.program.classes.get(current)
    if (!layout) return false
    if (layout.fields.some((field) => field.key === geaMountedElementMemberName)) return true
    current = layout.base
  }
  return false
}

/**
 * The declaration a `class-ref` receiver operand names, when it is both one
 * of gea's own component classes and one this compilation can actually call
 * `template` on -- or `null` for anything else.
 *
 * Read straight from the sealed plan rather than through `resolveRequiredOperand`:
 * an operand this bridge ultimately declines to redirect must not have picked
 * up an extra IR read as a side effect of merely being asked about, or the
 * core's own, unintercepted lowering of the same operand would mint a second,
 * redundant one right behind it.
 */
const eligibleClassOf = (
  ctx: LoweringContext,
  operand: SemanticOperand | undefined,
  componentClasses: ReadonlySet<DeclarationId>
): DeclarationId | null => {
  if (!operand || operand.source.kind !== 'result') return null
  const representation = ctx.plan.selected.get(operand.source.result)
  if (!representation || representation.kind !== 'class-ref') return null
  if (!componentClasses.has(representation.declaration)) return null
  return templateCallableOf(ctx, representation.declaration) ? representation.declaration : null
}

/** Whether `operand` is the constant text `text`. */
const isConstantText = (operand: SemanticOperand | undefined, text: string): boolean =>
  operand !== undefined && operand.source.kind === 'constant' && operand.source.text === text

/**
 * The property "get" half: `instance.render`, read but never called, is not
 * this bridge's concern (nothing in the corpus does that -- `citations.md`
 * section 2c) -- but the "get" that *is* about to be called still has to stop
 * being lowered here, before the core's generic property path mints a real
 * `get` IR operation for a member `class-layout.ts` was never told about,
 * which is the operation `emit-properties.ts`'s `classMemberText` refuses by
 * name today. This half builds nothing and registers nothing: the call that
 * immediately follows (`tryLowerRenderBridgeCall` below) rebuilds the whole
 * expression from its own `receiver` operand, which every method-shaped call
 * carries independent of how its callee was read (`ir/lower.ts`'s own
 * comment on `lowerInvocation`), so nothing downstream ever asks for a value
 * this "get" would have produced.
 */
const tryLowerRenderBridgeGet = (
  ctx: LoweringContext,
  operation: SemanticOperation,
  componentClasses: ReadonlySet<DeclarationId>
): boolean => {
  if (operation.family !== 'property' || operation.internalMethod !== 'get') return false
  if (!isConstantText(operandOf(operation, 'key', 0), geaRenderBridgeMemberName)) return false
  return eligibleClassOf(ctx, operandOf(operation, 'receiver', 0), componentClasses) !== null
}

/**
 * The call half: `instance.render(root, depth)` itself.
 *
 * Recognizing it needs both ends of the call: the receiver has to be an
 * instance of a class gea claims (the same test the "get" half above already
 * makes), and the callee has to actually be a read of `render` -- an eligible
 * receiver calling some *other* method it declares must not be redirected.
 * The callee is reached by walking back from the call's own `callee` operand
 * to the "get" operation that published it (`operationOfResult`), the same
 * indirection every consumer of a published result already goes through;
 * there is no second, faster path to the same fact.
 */
const tryLowerRenderBridgeCall = (
  ctx: LoweringContext,
  block: IrBlockId,
  operation: SemanticOperation,
  componentClasses: ReadonlySet<DeclarationId>
): boolean => {
  if (operation.family !== 'invocation' || operation.internalMethod !== 'call') return false
  const receiverOperand = operandOf(operation, 'receiver', 0)
  const declaration = eligibleClassOf(ctx, receiverOperand, componentClasses)
  if (!declaration || !receiverOperand) return false

  const calleeOperand = namedOperand(operation, 'callee')
  if (calleeOperand.source.kind !== 'result') return false
  const calleeOperation = ctx.graph.operations.get(operationOfResult(calleeOperand.source.result))
  if (!calleeOperation || calleeOperation.family !== 'property' || calleeOperation.internalMethod !== 'get') return false
  if (!isConstantText(operandOf(calleeOperation, 'key', 0), geaRenderBridgeMemberName)) return false

  const callable = templateCallableOf(ctx, declaration)
  if (!callable) return false
  const templateAbi = ctx.program.abis.get(callable)
  if (!templateAbi) {
    throw new IrLoweringBlockedError(
      `class ${declaration}'s "${geaRenderMemberName}" member has no projected calling convention for the render bridge to call`
    )
  }
  if (templateAbi.parameters.length > 0) {
    throw new IrLoweringBlockedError(
      `class ${declaration}'s "${geaRenderMemberName}" declares ${templateAbi.parameters.length} parameter(s); the render bridge ` +
        'calls it with none, the same as mounting a component with no attributes'
    )
  }

  const lineage = requireLineage(operation)
  const receiver = resolveRequiredOperand(ctx, block, lineage, receiverOperand)

  const rootOperand = operandOf(operation, 'argument', 0)
  if (!rootOperand) {
    throw new IrLoweringBlockedError('a render-bridge call names no root argument to attach the rendered tree under')
  }
  const root = resolveRequiredOperand(ctx, block, lineage, rootOperand)
  if (root.representation.kind !== 'native-handle') {
    throw new IrLoweringBlockedError(
      `a render-bridge call's root argument carries "${root.representation.kind}"; only a native host handle names a real place ` +
        'to attach the rendered tree'
    )
  }

  // The render call's second argument (`depth`) is read nowhere: v1's own
  // bridge casts it away unconditionally (`(void)_index;`), and no lowering
  // in either compiler ever gives it operational meaning. Not resolving it
  // at all is that same fact, not an omission of it.
  const templateRepresentation = { kind: 'function-value-dispatch' as const, abi: templateAbi }
  const bound = ctx.builder.allocateCallable(block, lineage, callable, [], templateRepresentation)
  const templateResult = ctx.builder.call(
    block,
    lineage,
    { value: bound, representation: templateRepresentation },
    receiver,
    [],
    templateAbi.result
  )
  if (templateResult === null) {
    throw new IrLoweringBlockedError(
      `class ${declaration}'s "${geaRenderMemberName}" returns "void"; a render bridge has nothing to attach`
    )
  }
  // Never a text leaf: what is attached here is a component's rendered SUBTREE,
  // a host node -- the one thing `isTextLeaf` refuses by carrier anyway.
  ctx.builder.elementChild(block, lineage, root, { value: templateResult, representation: templateAbi.result }, false)

  // The two steps the framework's own component runtime performs immediately
  // after attaching, in its order: install the root element, then run the
  // hook. `CompiledReactiveComponent.render` (the JS runtime v1 keeps whole for
  // any component declaring a lifecycle member) ends
  //
  //     this[GEA_ELEMENT] = node; this.rendered = true; this.onAfterRender()
  //
  // and this bridge is what stands in for that runtime natively. Without them
  // the hook is unreachable code: it is never emitted, the app's whole
  // start-up -- every `requestAnimationFrame` loop the corpus starts from one
  // -- never runs, and the program still compiles clean. That is the failure
  // mode this pair closes, and it is why they belong to the attach rather than
  // to a later pass.
  if (hasMountedElementField(ctx, declaration)) {
    const key = ctx.builder.constant(block, lineage, geaMountedElementMemberName, 'string', { kind: 'string' })
    ctx.builder.set(
      block,
      lineage,
      receiver,
      { value: key, representation: { kind: 'string' } },
      { value: templateResult, representation: templateAbi.result },
      true,
      null
    )
  }
  const afterRender = inheritedMethodOf(ctx, declaration, geaAfterRenderMemberName)
  const afterRenderAbi = afterRender ? ctx.program.abis.get(afterRender) : undefined
  if (afterRender && afterRenderAbi) {
    if (afterRenderAbi.parameters.length > 0) {
      throw new IrLoweringBlockedError(
        `class ${declaration}'s "${geaAfterRenderMemberName}" declares ${afterRenderAbi.parameters.length} parameter(s); the ` +
          'lifecycle hook is called with none'
      )
    }
    const hookRepresentation = { kind: 'function-value-dispatch' as const, abi: afterRenderAbi }
    const hook = ctx.builder.allocateCallable(block, lineage, afterRender, [], hookRepresentation)
    ctx.builder.call(block, lineage, { value: hook, representation: hookRepresentation }, receiver, [], afterRenderAbi.result)
  }

  // `render`'s own declared return type is `void` -- the structural cast
  // `mount()` writes states that, and nothing this compiler derives disagrees
  // -- so the call itself publishes nothing to register.
  registerResult(ctx, operation, null)
  return true
}

/** Both halves, tried in the order they are read: a "get" first, the call that reads it second. */
export const lowerGeaRenderBridge = (
  ctx: LoweringContext,
  block: IrBlockId,
  operation: SemanticOperation,
  componentClasses: ReadonlySet<DeclarationId>
): boolean => tryLowerRenderBridgeGet(ctx, operation, componentClasses) || tryLowerRenderBridgeCall(ctx, block, operation, componentClasses)
