import type { DeclarationId, IrValueId } from '../identity/ids.js'
import type { CallOperation, IrBody, IrOperand } from './model.js'
import { allOperationsOf } from './model.js'
import { operandsOfIrOperation } from './queries.js'

/**
 * Which `number` values one body may hold in a C++ `float`, and which of its
 * additions, subtractions, multiplications and divisions may be computed in
 * one.
 *
 * A Number is a double, and every value here is still exactly that double: a
 * value joins only when it is a float32 value by construction -- a
 * `Math.fround` result, a `Float32Array` element, a negation of one, or a
 * float32 constant -- so `float` storage holds it without loss and promoting
 * it back to `double` wherever a double is needed is exact.
 *
 * Arithmetic is the one place the representation changes what is computed,
 * and it is admitted on one condition: both operands are float32 values and
 * EVERY use of the result rounds it to float32 straight away (a
 * `Math.fround` argument or a `Float32Array` element store). For `+ - * /`
 * on two float32 operands, rounding the exact double result to float32 gives
 * the same value as the single-precision operation, because a double carries
 * more than twice float32's significand plus two bits (Figueroa, "When is
 * double rounding innocuous?", 1995). So `Math.fround(a * b)` computed as a
 * `float` multiply is the value ECMA-262 asks for, and an unrounded `a * b`
 * stays a double operation.
 *
 * The point is a core with a single-precision FPU and no double one (the
 * ESP32-S31 is `rv32imafc`): there every double operation is a software
 * routine, and a Gray-Scott step written the way such loops are written --
 * every intermediate wrapped in `Math.fround` -- ran forty of them per cell.
 */
export interface Float32Narrowing {
  /** SSA values whose C++ storage may be `float`. */
  readonly values: ReadonlySet<IrValueId>
  /** Binding cells whose C++ storage may be `float`. Every read of one is in `values`. */
  readonly bindings: ReadonlySet<DeclarationId>
  /** Binary compute results evaluated as single-precision arithmetic. */
  readonly arithmetic: ReadonlySet<IrValueId>
}

export const emptyFloat32Narrowing: Float32Narrowing = { values: new Set(), bindings: new Set(), arithmetic: new Set() }

const roundedOperators: ReadonlySet<string> = new Set(['+', '-', '*', '/'])

const isNumberScalar = (operand: { readonly representation: { readonly kind: string; readonly domain?: string } }): boolean =>
  operand.representation.kind === 'scalar' && operand.representation.domain === 'number'

/** A number literal that is its own float32 rounding: storing it in a `float` loses nothing. */
const isFloat32Literal = (text: string): boolean => {
  const value = Number(text)
  return Number.isFinite(value) && Math.fround(value) === value
}

/**
 * @param admitsCell whether a cell's storage is this body's to choose -- a
 *   cell another frame shares, or one declared outside this body, keeps the
 *   double its carrier spells.
 * @param excluded values another census already gave a storage of its own
 *   (the integer census's `long long`s).
 */
export const narrowableFloatsOf = (
  body: IrBody,
  admitsCell: (declaration: DeclarationId) => boolean,
  excluded: ReadonlySet<IrValueId>,
  exactIntegers: ReadonlySet<IrValueId> = new Set<IrValueId>()
): Float32Narrowing => {
  const stringKeys = new Map<IrValueId, string>()
  const float32Constants = new Set<IrValueId>()
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      if (operation.kind !== 'constant') continue
      if (operation.literal === 'string') stringKeys.set(operation.result.id, operation.text)
      else if (operation.literal === 'number' && isFloat32Literal(operation.text)) float32Constants.add(operation.result.id)
    }
  }

  // `Math.fround` authenticated by its native protocol, as `numericIntrinsicsOf`
  // authenticates `Math.imul`: a user object named Math has no such protocol.
  const froundCallees = new Set<IrValueId>()
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      if (operation.kind !== 'get') continue
      const receiver = operation.receiver.representation
      if (
        receiver.kind === 'native-handle' &&
        receiver.native === null &&
        receiver.protocol === 'Math' &&
        stringKeys.get(operation.key.value) === 'fround'
      )
        froundCallees.add(operation.result.id)
    }
  }
  const isFroundCall = (operation: CallOperation): boolean =>
    froundCallees.has(operation.callee.value) &&
    operation.arguments.length === 1 &&
    operation.arguments.every(isNumberScalar) &&
    operation.result !== null &&
    isNumberScalar(operation.result)

  type Definition =
    | { readonly kind: 'source' }
    | { readonly kind: 'negate'; readonly operand: IrValueId }
    | { readonly kind: 'arithmetic'; readonly operands: readonly IrValueId[] }
    | { readonly kind: 'phi'; readonly incoming: readonly IrValueId[] }
    | { readonly kind: 'cell'; readonly declaration: DeclarationId }
  const definitions = new Map<IrValueId, Definition>()
  const cellWrites = new Map<DeclarationId, IrValueId[]>()
  /** Values every use of which rounds to float32; struck by any other use. */
  const roundedUses = new Map<IrValueId, boolean>()
  const use = (value: IrValueId, rounds: boolean): void => {
    roundedUses.set(value, (roundedUses.get(value) ?? true) && rounds)
  }

  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      if (operation.kind === 'call' && isFroundCall(operation)) {
        definitions.set(operation.result!.id, { kind: 'source' })
        use(operation.arguments[0]!.value, true)
        use(operation.callee.value, false)
        continue
      }
      if (operation.kind === 'set' && operation.receiver.representation.kind === 'typed-array') {
        const keyText = stringKeys.get(operation.key.value)
        const elementStore =
          operation.receiver.representation.element === 'float32' && keyText === undefined && isNumberScalar(operation.value)
        use(operation.value.value, elementStore)
        use(operation.receiver.value, false)
        use(operation.key.value, false)
        continue
      }
      if (operation.kind === 'get' && operation.receiver.representation.kind === 'typed-array') {
        const keyText = stringKeys.get(operation.key.value)
        if (operation.receiver.representation.element === 'float32' && keyText === undefined && isNumberScalar(operation.result))
          definitions.set(operation.result.id, { kind: 'source' })
      } else if (operation.kind === 'compute' && isNumberScalar(operation.result)) {
        const operands = operation.operands
        if (operation.form === 'unary' && operation.operator === '-' && operands.length === 1 && isNumberScalar(operands[0]!))
          definitions.set(operation.result.id, { kind: 'negate', operand: operands[0]!.value })
        else if (
          operation.form === 'binary' &&
          roundedOperators.has(operation.operator) &&
          operands.length === 2 &&
          operands.every(isNumberScalar)
        )
          definitions.set(operation.result.id, { kind: 'arithmetic', operands: operands.map((operand) => operand.value) })
      } else if (operation.kind === 'phi' && isNumberScalar(operation.result)) {
        definitions.set(operation.result.id, { kind: 'phi', incoming: operation.incoming.map((incoming) => incoming.value.value) })
      } else if (operation.kind === 'binding-read' && isNumberScalar(operation.result)) {
        definitions.set(operation.result.id, { kind: 'cell', declaration: operation.declaration })
      } else if (operation.kind === 'binding-write') {
        const writes = cellWrites.get(operation.declaration) ?? []
        writes.push(operation.value.value)
        cellWrites.set(operation.declaration, writes)
        // A cell write is not a rounding: the cell is read back as a Number.
        use(operation.value.value, false)
        continue
      }
      for (const operand of operandsOfIrOperation(operation) as readonly IrOperand[]) use(operand.value, false)
    }
  }

  // Optimistic: every candidate is a float32 value until a premise fails, so a
  // loop-carried phi or a cell written from itself can settle at all.
  const values = new Set<IrValueId>([...definitions.keys()].filter((value) => !excluded.has(value)))
  const arithmetic = new Set<IrValueId>()
  const cells = new Set<DeclarationId>()
  for (const [declaration, writes] of cellWrites) if (admitsCell(declaration) && writes.length > 0) cells.add(declaration)
  const exact = (value: IrValueId): boolean => values.has(value) || float32Constants.has(value) || exactIntegers.has(value)
  const strike = (): boolean => {
    let struck = false
    let changed = true
    while (changed) {
      changed = false
      for (const declaration of [...cells]) {
        if ((cellWrites.get(declaration) ?? []).every(exact)) continue
        cells.delete(declaration)
        changed = struck = true
      }
      for (const value of [...values]) {
        const definition = definitions.get(value)!
        const holds =
          definition.kind === 'source'
            ? true
            : definition.kind === 'negate'
              ? exact(definition.operand)
              : definition.kind === 'arithmetic'
                ? definition.operands.every(exact) && roundedUses.get(value) === true
                : definition.kind === 'phi'
                  ? definition.incoming.every(exact)
                  : cells.has(definition.declaration)
        if (holds) continue
        values.delete(value)
        changed = struck = true
      }
    }
    return struck
  }
  // Exact is not enough: a `let x = 0` written only with float32 constants is
  // exact too, and moving every such counter into a `float` would change the
  // storage of programs that never touch single precision. A value keeps
  // `float` storage only when a float32 source reaches it -- the least
  // fixpoint from `fround` results and `Float32Array` reads.
  const ground = (): boolean => {
    const grounded = new Set<IrValueId>()
    const groundedCells = new Set<DeclarationId>()
    let changed = true
    while (changed) {
      changed = false
      for (const value of values) {
        if (grounded.has(value)) continue
        const definition = definitions.get(value)!
        const reached =
          definition.kind === 'source' || definition.kind === 'arithmetic'
            ? true
            : definition.kind === 'negate'
              ? grounded.has(definition.operand)
              : definition.kind === 'phi'
                ? definition.incoming.some((incoming) => grounded.has(incoming))
                : groundedCells.has(definition.declaration)
        if (!reached) continue
        grounded.add(value)
        changed = true
      }
      for (const declaration of cells) {
        if (groundedCells.has(declaration) || !(cellWrites.get(declaration) ?? []).some((write) => grounded.has(write))) continue
        groundedCells.add(declaration)
        changed = true
      }
    }
    let removed = false
    for (const value of [...values]) if (!grounded.has(value)) (values.delete(value), (removed = true))
    for (const declaration of [...cells]) if (!groundedCells.has(declaration)) (cells.delete(declaration), (removed = true))
    return removed
  }
  strike()
  while (ground() && strike());
  for (const value of values) if (definitions.get(value)?.kind === 'arithmetic') arithmetic.add(value)
  return { values, bindings: cells, arithmetic }
}
