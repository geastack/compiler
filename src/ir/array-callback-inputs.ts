import type { IrValueId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import type { ConstantOperation, IrOperation } from './model.js'

/**
 * The callback parameters an `Array.prototype` member's runtime template fills
 * with a receiver element, by member. `reduce`/`reduceRight` hand the element
 * to the second parameter; the first is the accumulator, below.
 */
const elementParameters: ReadonlyMap<string, readonly number[]> = new Map([
  ['forEach', [0]],
  ['map', [0]],
  ['filter', [0]],
  ['some', [0]],
  ['every', [0]],
  ['find', [0]],
  ['findIndex', [0]],
  ['findLast', [0]],
  ['findLastIndex', [0]],
  ['flatMap', [0]],
  ['sort', [0, 1]],
  ['reduce', [1]],
  ['reduceRight', [1]]
])

const reducers: ReadonlySet<string> = new Set(['reduce', 'reduceRight'])

export interface ArrayCallbackCallee {
  readonly member: string
  readonly element: Representation
}

const boxes = (representation: Representation): boolean =>
  representation.kind === 'dynamic' ||
  (representation.kind === 'optional' && boxes(representation.payload)) ||
  (representation.kind === 'borrowed-ref' && boxes(representation.referent))

/**
 * Every `get` of a callback-taking `Array.prototype` member off an
 * `array-object`, by the value the following `call` names as its callee --
 * `xs.map(f)` is a read of `map`, then a call through it.
 */
export const arrayCallbackCalleesOf = (
  operations: readonly IrOperation[],
  constants: ReadonlyMap<string, ConstantOperation>
): ReadonlyMap<IrValueId, ArrayCallbackCallee> => {
  const callees = new Map<IrValueId, ArrayCallbackCallee>()
  for (const operation of operations) {
    if (operation.kind !== 'get') continue
    const receiver = operation.receiver.representation
    const array = receiver.kind === 'optional' ? receiver.payload : receiver
    if (array.kind !== 'array-object') continue
    const key = constants.get(String(operation.key.value))
    if (key?.literal !== 'string' || !elementParameters.has(key.text)) continue
    callees.set(operation.result.id, { member: key.text, element: array.element })
  }
  return callees
}

/**
 * The native carriers such a call boxes where no IR operation shows it.
 *
 * The member's runtime template calls the callback itself, so an element
 * entering a `dynamic` parameter -- an unannotated `(a, item) => a +
 * item.weight` over a typed rest array -- is converted inside the emitter's
 * adapter rather than by a `convert` the census below would see. A box made
 * there is read through the element's field protocol exactly like any other,
 * so the element owes that protocol. A reducer's accumulator adds its seed
 * (the initial value, or the first element) and the callback's own result.
 */
export const arrayCallbackBoxedInputs = (
  operation: IrOperation,
  callees: ReadonlyMap<IrValueId, ArrayCallbackCallee>
): readonly Representation[] => {
  if (operation.kind !== 'call' || operation.argumentsAreSpread) return []
  const callee = callees.get(operation.callee.value)
  const callback = operation.arguments[0]?.representation
  if (!callee || callback?.kind !== 'function-value-dispatch') return []
  const { parameters, result } = callback.abi
  const boxed: Representation[] = []
  for (const position of elementParameters.get(callee.member) ?? []) {
    const parameter = parameters[position]
    if (parameter && boxes(parameter.value) && !boxes(callee.element)) boxed.push(callee.element)
  }
  const accumulator = parameters[0]
  if (reducers.has(callee.member) && accumulator && boxes(accumulator.value)) {
    const seed = operation.arguments[1]?.representation ?? callee.element
    for (const input of [seed, result]) if (!boxes(input)) boxed.push(input)
  }
  return boxed
}
