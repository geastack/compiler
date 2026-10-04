import type { Representation } from '../representation/model.js'
import type { IrBody, IrOperation } from './model.js'
import { allOperationsOf } from './model.js'
import { operandsOfIrOperation, resultOfIrOperation } from './queries.js'
import type { ReflectionExposure } from './reflection-demand.js'

/**
 * Which plain records have a key creation order nothing in the program can
 * read.
 *
 * A record's keys enumerate in the order they were created
 * (ECMA-262 10.1.11.1), which the runtime keeps per record: a note on every
 * store that creates a declared field out of layout order, a pend on every
 * literal written out of order, and an order-preserving walk on every spread
 * and `Object.assign`. A wide options record pays all of it on every
 * operation, and the order is read by nothing but enumeration.
 *
 * A shape is UNOBSERVED when
 *  - the reflection census holds it at `keys-only`: it never reaches a dynamic
 *    or unknown boundary, so no dynamic walk (`Object.keys` on a boxed value,
 *    `JSON.stringify`, a console, a bson serializer) can list its keys;
 *  - no operation lists its keys: `own-property-keys`, a `for`-`in`, the
 *    `Object.keys`/`values`/`entries` intrinsics, or any host template other
 *    than `Object.assign`;
 *  - nothing that receives its keys in order is observed: a spread or
 *    `Object.assign` copies the source's order into its receiver, so a source
 *    is observed wherever its receiver is (a fixpoint);
 *  - it never leaves for a non-record carrier by a conversion. A conversion to
 *    ANOTHER record shape is a view, which is built field by field in the
 *    target's layout order and keeps no part of the source's order.
 *
 * Everything not proven is observed, so a shape this cannot see through keeps
 * today's behaviour. An incomplete reflection census proves nothing, and a
 * record with an index sidecar is never proven (its sidecar keys interleave
 * with the declared ones).
 */
export interface KeyOrderObservation {
  /** Shape ids whose creation order is provably unread. */
  readonly unobserved: ReadonlySet<string>
}

export const nothingProvenUnobserved: KeyOrderObservation = { unobserved: new Set() }

/**
 * Collects the plain record shapes a value's representation holds into
 * `out`, looking through presence, borrows and unions -- and through the
 * element of an Array, a promise or a sequence when `containers`. False when
 * it also holds something that is not a plain record or a primitive (a class,
 * a dictionary, a dynamic value, a host handle...): a value that may be an
 * object whose keys are listed some other way.
 */
const collectShapes = (representation: Representation, out: Set<string>, indexed: Set<string>, containers: boolean): boolean => {
  switch (representation.kind) {
    case 'record':
      out.add(representation.shapeId)
      return true
    case 'record-with-index':
      out.add(representation.shapeId)
      indexed.add(representation.shapeId)
      return true
    case 'native-record-ref':
      if (representation.native !== null || representation.recursive !== undefined) return false
      out.add(representation.shapeId)
      return true
    case 'optional':
      return collectShapes(representation.payload, out, indexed, containers)
    case 'borrowed-ref':
      return collectShapes(representation.referent, out, indexed, containers)
    case 'tagged-union': {
      let closed = true
      for (const arm of representation.arms) closed = collectShapes(arm.value, out, indexed, containers) && closed
      return closed
    }
    case 'array-object':
      return !containers || collectShapes(representation.element, out, indexed, containers)
    case 'promise':
      return !containers || collectShapes(representation.value, out, indexed, containers)
    case 'native-sequence':
    case 'dense-buffer':
      return !containers || collectShapes(representation.element, out, indexed, containers)
    case 'scalar':
    case 'string':
    case 'symbol':
    case 'null':
    case 'undefined':
    case 'void':
      return true
    default:
      return false
  }
}

export const keyOrderObservationOf = (
  bodies: readonly IrBody[],
  reflection: ReflectionExposure | null | undefined
): KeyOrderObservation => {
  if (!reflection || !reflection.complete) return nothingProvenUnobserved
  const watch = process.env['GEA_KEY_ORDER_DEBUG']
  const observed = new Set<string>()
  // Diagnostic only: why a watched shape (key substring) was marked observed.
  let why = ''
  const mark = (shape: string): void => {
    if (watch !== undefined && shape.includes(watch) && !observed.has(shape)) console.error(`[KEY-ORDER] ${shape} observed by ${why}`)
    observed.add(shape)
  }
  const indexed = new Set<string>()
  // A source's order is copied into its receivers: it is observed wherever one of them is.
  const feeds = new Map<string, Set<string>>()
  const shapesOf = (representation: Representation, containers: boolean): { shapes: Set<string>; closed: boolean } => {
    const shapes = new Set<string>()
    const closed = collectShapes(representation, shapes, indexed, containers)
    return { shapes, closed }
  }
  const observe = (representation: Representation): void => {
    for (const shape of shapesOf(representation, true).shapes) mark(shape)
  }
  const feed = (receiver: Representation, source: Representation): void => {
    const into = shapesOf(receiver, false)
    const from = shapesOf(source, false)
    // A receiver that is not a plain record shape (a dictionary, a dynamic value, a class...) keeps the order it is
    // handed and lists it some way this does not see.
    if (!into.closed || into.shapes.size === 0) {
      for (const shape of from.shapes) mark(shape)
      return
    }
    for (const shape of from.shapes) {
      const receivers = feeds.get(shape) ?? new Set<string>()
      for (const receiverShape of into.shapes) receivers.add(receiverShape)
      feeds.set(shape, receivers)
    }
  }
  const observeAll = (operation: IrOperation): void => {
    for (const operand of operandsOfIrOperation(operation)) observe(operand.representation)
    const result = resultOfIrOperation(operation)
    if (result) observe(result.representation)
  }
  const visit = (operation: IrOperation): void => {
    why = `${operation.kind}${operation.kind === 'call' ? `:${String(operation.hostTemplate)}:${String(operation.intrinsicOwnKeys)}:${String((operation as { callee?: { value?: unknown } }).callee?.value)}` : ''}`
    switch (operation.kind) {
      case 'own-property-keys':
      case 'get-iterator':
        observeAll(operation)
        return
      case 'spread-copy':
        feed(operation.receiver.representation, operation.source.representation)
        return
      // Each live arm's payload is converted into the merge's carrier, one `convert` apiece: a view
      // onto another record shape, which keeps no part of the source's order.
      case 'merge-live-arm-rebuild':
      case 'convert': {
        const source = shapesOf(operation.source.representation, true)
        if (source.shapes.size === 0) return
        if (!shapesOf(operation.result.representation, true).closed) for (const shape of source.shapes) mark(shape)
        return
      }
      case 'call': {
        if (operation.hostTemplate === 'object-assign' && !operation.argumentsAreSpread) {
          const [target, ...sources] = operation.arguments
          if (target === undefined) return
          // A packed source list feeds the target from each ELEMENT, the way
          // the same sources written out would; the array itself is no source.
          if (operation.assignSourcesPacked) {
            const packed = sources[0]?.representation
            if (packed?.kind !== 'array-object' || sources.length !== 1) return observeAll(operation)
            feed(target.representation, packed.element)
            return
          }
          for (const source of sources) feed(target.representation, source.representation)
          return
        }
        if (operation.intrinsicOwnKeys || operation.hostTemplate !== undefined || operation.argumentsAreSpread) observeAll(operation)
        return
      }
      default:
        return
    }
  }
  for (const body of bodies) for (const block of body.blocks.values()) for (const operation of allOperationsOf(block)) visit(operation)
  const provable = (shape: string): boolean => {
    const demand = reflection.records.get(shape as never)
    return demand !== undefined && demand.level === 'keys-only' && !indexed.has(shape) && !observed.has(shape)
  }
  // A fixpoint: a source is observed wherever a receiver it feeds is, and a receiver that is not provable is observed.
  for (let changed = true; changed;) {
    changed = false
    for (const [source, receivers] of feeds) {
      if (observed.has(source)) continue
      for (const receiver of receivers)
        if (!provable(receiver)) {
          why = `feeds ${receiver}`
          mark(source)
          changed = true
          break
        }
    }
  }
  const unobserved = new Set<string>()
  if (watch !== undefined)
    for (const [shape, demand] of reflection.records)
      if ((shape as string).includes(watch))
        console.error(
          `[KEY-ORDER] ${String(shape)} level=${demand.level} indexed=${indexed.has(shape as string)} observed=${observed.has(shape as string)}`
        )
  for (const shape of reflection.records.keys()) if (provable(shape as string)) unobserved.add(shape as string)
  return { unobserved }
}
