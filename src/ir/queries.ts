import type { AllocateArrayObjectOperation, IrBlockId, IrOperand, IrOperation, IrResult, IrTerminatorOperation } from './model.js'
import { nativeAbsentPropertyReadOf } from './native-absent-property.js'

/**
 * Uniform queries over an IR operation.
 *
 * Split out of `model.ts`: the model states what an operation *is*; these
 * state what any consumer needs to ask of one -- its successors, the value it
 * defines, the values it reads -- so no consumer re-derives the answer per
 * kind and drifts from the others.
 */

/**
 * Whether building this array runs a genuinely dynamic iteration protocol --
 * a `gather` element drains an already-acquired iterator record
 * (`ir/model.ts`'s `IrArrayElement`), and GetIterator/IteratorStep/
 * IteratorValue can each invoke a user-defined method (`producers/
 * protocol.ts`'s `mintIteratorSteps` marks every one of those steps
 * `callsUserCode: true`). A `spread` element is the opposite: a native
 * range-copy off an Array/Set/Map/string/cursor with no protocol dispatch at
 * all, and an `element`/`hole` is a value the program already has.
 *
 * One authority for both DCE passes that ask "is this allocation pure": a
 * body-local backward slice (`ir/shake.ts`) and a per-value dead-result check
 * (`ir/dead-values.ts`). Both used to answer `allocate-array-object`
 * unconditionally `true` -- correct for `[1, 2, 3]`, wrong for
 * `[...abrupt]`, whose `next()` can throw. An unread `[...abrupt]` then
 * disappeared whole, silently skipping an iteration the language always runs.
 */
export const arrayAllocationDrainsDynamicIterator = (operation: AllocateArrayObjectOperation): boolean =>
  operation.elements.some((element) => element.kind === 'gather')

/**
 * Carrier observations do not expose object fields or invoke coercion methods.
 * Instance tests qualify only through their sealed native membership recipe;
 * an arbitrary constructor can still execute Symbol.hasInstance. Both callable
 * escape and reflection must consume this same effect, or an already-native
 * test can invent an escape that indirectly restores every reflection hook.
 */
export const observesNativeCarrierOnly = (operation: IrOperation): boolean =>
  nativeAbsentPropertyReadOf(operation) !== null ||
  operation.kind === 'test' ||
  // Evaluating a native subclass retains its already-evaluated superclass's
  // prototype owner. It neither calls that constructor nor exposes the
  // fields of instances the constructor may produce. Captures and unknown
  // heritage carriers still require their ordinary boundary analysis.
  (operation.kind === 'allocate-constructor' &&
    operation.captures.length === 0 &&
    operation.result.representation.kind === 'constructor-family' &&
    (operation.heritage === undefined || operation.heritage.representation.kind === 'constructor-family')) ||
  (operation.kind === 'compute' &&
    (operation.form === 'typeof' ||
      (operation.form === 'instanceof' && operation.classInstanceTest?.nativeFieldProtocol === 'unused') ||
      operation.form === 'require-object-coercible' ||
      operation.form === 'require-iterable-present' ||
      operation.form === 'require-tagged-union-arm' ||
      (operation.form === 'unary' && (operation.operator === '!' || operation.operator === 'void')) ||
      (operation.form === 'equality' && (operation.operator === '===' || operation.operator === '!=='))))

/** The block each terminator can transfer control to, in no particular order. */
export const successorsOfTerminator = (terminator: IrTerminatorOperation): readonly IrBlockId[] => {
  switch (terminator.kind) {
    case 'branch':
      return [terminator.whenTrue, terminator.whenFalse]
    case 'jump':
      return [terminator.target]
    case 'return':
    case 'throw':
      return []
    case 'switch':
      return [...terminator.cases.map((c) => c.target), terminator.defaultTarget]
  }
}

/** The value this operation defines, or `null` for an operation that only has effects or transfers control. */
export const resultOfIrOperation = (operation: IrOperation): IrResult | null => {
  switch (operation.kind) {
    case 'binding-write':
    case 'commonjs-binding-set':
    case 'super-initialize':
    case 'reparent-constructor':
    case 'branch':
    case 'jump':
    case 'return':
    case 'throw':
    case 'switch':
    // `CopyDataProperties` is not a value a JS consumer ever reads. See
    // `SpreadCopyOperation`.
    case 'spread-copy':
      return null
    // A `yield` publishes the RESUME value (what `next(v)`/an abrupt
    // `.return`/`.throw` sends back), when this generator's `TNext` resolved
    // to a native carrier -- `null` otherwise, exactly like `operation.result`
    // itself. Falls to `default` structurally; named here only so a reader
    // does not have to check that `yield` is not one of the `null` cases
    // just above.
    case 'yield':
      return operation.result
    default:
      return operation.result
  }
}

/** Every value this operation reads, flattened and stripped of role, for uniform representation-consistency checking. */
export const operandsOfIrOperation = (operation: IrOperation): readonly IrOperand[] => {
  switch (operation.kind) {
    case 'get':
    case 'has-property':
      return [operation.receiver, operation.key]
    case 'set':
    case 'define-own-property':
      return [operation.receiver, operation.key, operation.value]
    case 'delete':
      return [operation.receiver, operation.key]
    case 'spread-copy':
      return [operation.receiver, operation.source]
    case 'own-property-keys':
      return [operation.receiver]
    case 'compute':
      return operation.operands
    case 'call':
      return [operation.callee, ...(operation.receiver ? [operation.receiver] : []), ...operation.arguments]
    case 'commonjs-require':
    case 'commonjs-binding':
      return []
    case 'commonjs-binding-set':
      return [operation.value]
    case 'super-initialize':
      return operation.arguments
    case 'reparent-constructor':
      return [operation.classValue, operation.heritage]
    case 'construct':
      return [operation.callee, operation.newTarget, ...operation.arguments]
    case 'constant':
      return []
    case 'binding-read':
      return []
    case 'parameter':
    case 'receiver':
    case 'global-this':
    case 'catch-binding':
      // The value comes from the frame (or the catch clause's own native
      // parameter), not from another operation in this body.
      return []
    case 'unresolvable-reference':
      // Nothing is read: the fact this citation states is that the NAME has
      // no cell anywhere, which is settled before this operation exists, not
      // computed from an operand.
      return []
    case 'await':
      return [operation.operand]
    case 'yield':
      return operation.operand ? [operation.operand] : []
    case 'binding-write':
      return [operation.value]
    case 'phi':
      return operation.incoming.map((edge) => edge.value)
    case 'branch':
      return [operation.condition]
    case 'jump':
      return []
    case 'return':
      return operation.value ? [operation.value] : []
    case 'throw':
      return [operation.value]
    case 'switch':
      return [operation.discriminant, ...operation.cases.map((c) => c.test)]
    case 'allocate-ordinary-object':
      return []
    case 'allocate-array-object':
      // A `spread` element reads its source array exactly as an `element`
      // reads its value -- `[a, ...b]` evaluates `b`. Matching only
      // `'element'` here left the spread's source looking unread by every
      // consumer of this function, and the shaker deleted the operation that
      // produced it while keeping the allocation that reads it: a body whose
      // emitter then refused with "read before it is defined". `hole` is the
      // one arm that really does read nothing.
      return operation.elements.flatMap((element) =>
        element.kind === 'hole' ? [] : [element.kind === 'gather' ? element.iterator : element.value]
      )
    case 'allocate-callable':
      return operation.captures
    case 'bind-callable':
      return [
        operation.source,
        ...(operation.thisArgument ? [operation.thisArgument] : []),
        ...(operation.receiver ? [operation.receiver] : []),
        ...operation.bound
      ]
    case 'allocate-constructor':
      return [...operation.captures, ...(operation.heritage ? [operation.heritage] : [])]
    case 'allocate-proxy':
      return [operation.target, operation.handler]
    case 'allocate-record':
      return operation.fields.map((field) => field.value)
    case 'allocate-template-object':
      // The segments are constants the producer read off the source tokens;
      // nothing in the body is read to build the object.
      return []
    case 'allocate-regexp':
      // The pattern and its flags are constants the producer read off the
      // literal's own token; nothing in the body is read to build the object.
      return []
    case 'convert':
    case 'merge-live-arm-rebuild':
      return [operation.source]
    case 'get-iterator':
      return operation.method ? [operation.receiver, operation.method] : [operation.receiver]
    case 'iterator-next':
      return operation.value ? [operation.iterator, operation.value] : [operation.iterator]
    case 'iterator-done':
      return [operation.iterator]
    case 'iterator-close':
      return [operation.iterator]
    case 'element':
      return operation.tag ? [operation.tag] : []
    case 'element-prop':
      return [operation.node, operation.key, operation.value]
    case 'element-child':
      return [operation.node, operation.child]
    case 'test':
      return [operation.value]
  }
}
