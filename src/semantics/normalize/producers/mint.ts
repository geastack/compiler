import type { NodeId, OperationFamily, OperationId, ResultRole, StructuralTypeId } from '../../../identity/ids.js'
import { operationId, semanticResultId } from '../../../identity/ids.js'
import type { CensusBlocker } from '../../model/coverage.js'
import type { OperandEvaluation, OperandSource, SemanticCaller, SemanticOperand, SemanticResult } from '../../model/operands.js'
import type { PrimitiveFamily } from '../../model/coverage.js'

/**
 * Shared minting helpers for family producers.
 *
 * One AST node can normalize to several operations, and the ordinal is what
 * keeps them apart. Producers must allocate ordinals from a single counter per
 * node so that two producers cannot mint the same identity for different
 * operations -- which would silently merge two operations into one.
 */

export interface OrdinalCounter {
  readonly next: (source: NodeId, family: OperationFamily) => number
}

export const createOrdinalCounter = (): OrdinalCounter => {
  // By family, then by node: a node id is a string the census already holds,
  // while a joined `${source}|${family}` key was a fresh string per operation
  // (~30 MB on a 48K-line app). A family name holds no `|`, so the joined key
  // was injective and this counts exactly the same pairs.
  //
  // Nearly every pair mints once, so a pair is first only remembered as used
  // (`MintedSources`) and given a count when it mints a second time.
  const once = new Map<OperationFamily, MintedSources>()
  const more = new Map<OperationFamily, Map<NodeId, number>>()
  return {
    next: (source, family) => {
      let used = once.get(family)
      if (!used) once.set(family, (used = new MintedSources()))
      if (used.add(source)) return 0
      let counts = more.get(family)
      if (!counts) more.set(family, (counts = new Map()))
      const ordinal = counts.get(source) ?? 1
      counts.set(source, ordinal + 1)
      return ordinal
    }
  }
}

/**
 * The (file, ordinal) coordinate of an unspecialized `node|f<file>|<kind>|<ordinal>`
 * identity as one number, or -1 for any other spelling. The kind is left out:
 * `nodeId` is minted only from a node's own kind, so the coordinate already
 * names it. Digits with a leading zero are refused, so no two spellings share a
 * coordinate.
 */
const plainCoordinate = (id: string): number => {
  if (!id.startsWith('node|f')) return -1
  const fileEnd = id.indexOf('|', 6)
  const ordinalStart = id.lastIndexOf('|') + 1
  if (fileEnd < 0 || ordinalStart <= fileEnd + 1) return -1
  const file = decimalAt(id, 6, fileEnd)
  const ordinal = decimalAt(id, ordinalStart, id.length)
  return file < 0 || ordinal < 0 || file >= coordinateSpan || ordinal >= coordinateSpan ? -1 : file * coordinateSpan + ordinal
}
const coordinateSpan = 2 ** 26
const decimalAt = (text: string, from: number, to: number): number => {
  if (to <= from || to - from > 8 || (to - from > 1 && text.charCodeAt(from) === 48)) return -1
  let value = 0
  for (let at = from; at < to; at++) {
    const digit = text.charCodeAt(at) - 48
    if (digit < 0 || digit > 9) return -1
    value = value * 10 + digit
  }
  return value
}

/**
 * The sources one family has minted from: a bit per (file, ordinal) for an
 * unspecialized node identity -- nearly every source -- and the spelling of
 * any other. A set entry per pair was ~9 MB on a 48K-line app, alive to the
 * end of production, the frontend's peak.
 */
class MintedSources {
  readonly #files: (Uint32Array | undefined)[] = []
  readonly #others = new Set<NodeId>()

  /** Whether `source` was new, remembering it either way. */
  add(source: NodeId): boolean {
    const coordinate = plainCoordinate(source)
    if (coordinate < 0) {
      if (this.#others.has(source)) return false
      this.#others.add(source)
      return true
    }
    const file = Math.floor(coordinate / coordinateSpan)
    const ordinal = coordinate % coordinateSpan
    const word = ordinal >>> 5
    let bits = this.#files[file]
    if (bits === undefined || word >= bits.length) {
      const grown = new Uint32Array(Math.max(word + 1, (bits?.length ?? 0) * 2, 64))
      if (bits !== undefined) grown.set(bits)
      this.#files[file] = bits = grown
    }
    const bit = 1 << (ordinal & 31)
    if ((bits[word]! & bit) !== 0) return false
    bits[word]! |= bit
    return true
  }
}

/**
 * Per-caller evaluation sequencing.
 *
 * Evaluation order is a property of the executing context, not of the family
 * that happens to be publishing. One counter per caller shared by every producer
 * is what keeps two families from handing out the same ordinal inside one
 * function -- which would give two distinct operations one identity.
 */
export interface EvaluationOrdinals {
  readonly next: (caller: SemanticCaller) => number
}

const callerKey = (caller: SemanticCaller): string => (caller.kind === 'function' ? `fn|${caller.functionId}` : `region|${caller.regionId}`)

export const createEvaluationOrdinals = (): EvaluationOrdinals => {
  const used = new Map<string, number>()
  return {
    next: (caller) => {
      const key = callerKey(caller)
      const ordinal = used.get(key) ?? 0
      used.set(key, ordinal + 1)
      return ordinal
    }
  }
}

export const mintOperationId = (counter: OrdinalCounter, source: NodeId, family: OperationFamily): OperationId =>
  operationId(source, family, counter.next(source, family))

export const mintResult = (operation: OperationId, role: ResultRole, type: StructuralTypeId): SemanticResult => ({
  id: semanticResultId(operation, role),
  role,
  type
})

/** Shared: an operand's evaluation is read and never written, and nearly every operand is `runtime`. */
const runtimeEvaluation: OperandEvaluation = Object.freeze({ kind: 'runtime' })

export const operand = (
  role: string,
  ordinal: number,
  source: OperandSource,
  type: StructuralTypeId,
  evaluation: OperandEvaluation = runtimeEvaluation
): SemanticOperand => ({ role, ordinal, source, type, evaluation })

/**
 * A blocker states a missing capability, not a source shape.
 *
 * "cannot normalize `foo.bar` in file X" is not a blocker: it names a site. The
 * blocker must name what the compiler cannot yet do, so that fixing it fixes
 * every site at once.
 */
export const blocked = (
  source: NodeId,
  family: OperationFamily,
  reason: string,
  missingPrimitive: PrimitiveFamily | null
): CensusBlocker => ({
  source,
  family,
  reason,
  missingPrimitive
})
