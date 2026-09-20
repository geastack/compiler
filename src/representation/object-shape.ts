import { functionId } from '../identity/ids.js'
import type { StructuralTypeId } from '../identity/ids.js'
import type { PropertyKeyShape, StructuralIndexShape, StructuralShape } from '../semantics/model/structural-types.js'
import { symbolPropertyKeyText } from '../semantics/model/structural-types.js'
import type { RecordAccessor, Representation } from './model.js'

/**
 * How an object *shape* divides into the physical parts a record carrier is
 * made of: which members are storage, which index signature rides alongside
 * them, and which members are not stored at all because a body answers them.
 *
 * Read off the shape and nothing else. A use site that re-decided any of this
 * would be a second authority over one layout, and the two would disagree
 * exactly where it is least visible -- a field the allocation writes and the
 * read never looks at.
 */

/**
 * A structural index signature narrowed to a key domain this compiler can
 * actually carry. String, number, and symbol each have a physical container
 * (`Dictionary`/`NumericDictionary`/`SymbolDictionary` in
 * `targets/cpp/runtime/gea_runtime.h`). A symbol sidecar stores the runtime
 * `gea::Symbol` identity itself; collapsing it to a printable description
 * would make distinct `Symbol('state')` values alias, while boxing it into a
 * string table would violate the no-boxing rule. Carrying `key` as this
 * narrowed union, rather than the raw
 * `StructuralIndexShape['key']`, is what lets a caller spell `dictionary`'s
 * key or a `record-with-index` sidecar directly without re-deciding (or
 * casting) it.
 */
export interface CarriableIndex {
  readonly key: 'string' | 'number' | 'symbol'
  readonly value: StructuralTypeId
}

export const carriableIndexOf = (index: StructuralIndexShape): CarriableIndex | null =>
  index.key === 'string' || index.key === 'number' || index.key === 'symbol' ? { key: index.key, value: index.value } : null

/** Every index domain the structural model can carry, preserving its JS domain. */
export const carriableIndexesOf = (shape: Extract<StructuralShape, { kind: 'object' }>): readonly CarriableIndex[] | string => {
  const result: CarriableIndex[] = []
  for (const index of shape.index) {
    const carriable = carriableIndexOf(index)
    if (!carriable) return `no primitive for a record carrier with a ${index.key}-keyed index signature`
    result.push(carriable)
  }
  return result
}

/**
 * An object shape's own single string- or number-index, members-free
 * dictionary body, or `null` when it is not shaped like one.
 *
 * Read entirely off `index`/`members` -- the shape's own structure -- so a
 * named declaration can ask this exact question about its body (below)
 * without deriving anything beyond the one index value a real dictionary
 * answer needs.
 */
/**
 * The index signatures a shape physically has, which is not always the number
 * TypeScript reports.
 *
 * `[x: string | number]: unknown` (mongodb's `WriteConcernErrorResult`) is ONE
 * index signature the program wrote, and the checker models it as TWO index
 * infos -- one per key domain -- carrying the identical value type. Reading
 * that as "more than one index signature" refuses a shape that declares a
 * single one.
 *
 * The collapse is a fact about the language, not a convenience: a property key
 * IS a string (ECMA-262 `ToPropertyKey`), so `obj[1]` and `obj['1']` name the
 * same property, and TypeScript itself enforces that a numeric index type is
 * assignable to the string one (TS2413). A string-keyed `gea::Dictionary`
 * therefore already carries every key the numeric domain admits -- the numeric
 * info is a VIEW of that storage, never storage of its own.
 *
 * Gated on the two infos agreeing EXACTLY on their value id. Assignability is
 * not identity, and a shape whose numeric domain carries a genuinely narrower
 * value -- `{ [k: string]: unknown; [k: number]: string }` -- has two different
 * carriers and keeps refusing, rather than being silently widened to one.
 */
export const physicalIndexesOf = (shape: Extract<StructuralShape, { kind: 'object' }>): readonly StructuralIndexShape[] => {
  if (shape.index.length !== 2) return shape.index
  const stringIndex = shape.index.find((one) => one.key === 'string')
  const numberIndex = shape.index.find((one) => one.key === 'number')
  if (!stringIndex || !numberIndex) return shape.index
  if (stringIndex.value !== numberIndex.value || stringIndex.readonly !== numberIndex.readonly) return shape.index
  return [stringIndex]
}

export const dictionaryIndexOf = (shape: Extract<StructuralShape, { kind: 'object' }>): CarriableIndex | null => {
  const indexes = physicalIndexesOf(shape)
  const [only] = indexes
  if (shape.members.length !== 0 || indexes.length !== 1 || !only) return null
  return carriableIndexOf(only)
}

/**
 * The record-field key text for one structural member.
 *
 * A string or number key is spelled exactly as the language names it --
 * `String(key.value)`, unchanged from before -- because that text *is* the
 * field the program wrote. A symbol key has no such text: two symbols the
 * program never confuses (`Symbol('x')` created twice, or `Symbol.iterator`
 * versus a `unique symbol` that happens to print the same) can share a
 * printable description, so the description is not a name a field could
 * safely be keyed by. What a symbol key *does* have, uniquely, is the
 * declaration `structural.ts`'s `keyOfSymbol` already anchored it to -- the
 * same identity `structuralShapeKey` (semantics/model/structural-types.ts)
 * already keys a shape by (`sym(<declaration>)`), which is why this reuses
 * that exact text rather than inventing a second spelling for one fact. This
 * is a compile-time-constant identity, not a runtime string, so the field it
 * names is an ordinary struct member -- `targets/cpp/types.ts`'s
 * `cppRecordFieldName` is the one place that text becomes the member's actual
 * C++ name, the same split a tuple's positional key already uses.
 */
export const recordFieldKeyOf = (key: PropertyKeyShape): string =>
  key.kind === 'symbol' ? symbolPropertyKeyText(key.declaration) : String(key.value)

export const recordAccessorsOf = (
  shape: Extract<StructuralShape, { kind: 'object' }>,
  /** The caller's own `deriveStored` -- the identical call a data field's carrier comes from. See `RecordAccessor.value`. */
  deriveStored: (type: StructuralTypeId) => Representation
): readonly RecordAccessor[] =>
  shape.members.flatMap((member) =>
    member.accessor
      ? [
          {
            key: recordFieldKeyOf(member.key),
            // The declaration *is* the function's identity here: `functionId`
            // is the one rule that maps a declaration to the body compiled
            // for it, and re-spelling it locally would be a second answer to
            // a question the identity module already owns.
            getter: member.accessor.getter ? functionId(member.accessor.getter) : null,
            setter: member.accessor.setter ? functionId(member.accessor.setter) : null,
            value: deriveStored(member.type)
          }
        ]
      : []
  )

/**
 * Whether an object shape is pure data: named members, every one a value rather
 * than something callable, none accessor-backed (an accessor has no storage and
 * so contributes no field), and no index signature.
 *
 * This is the whole of the transparent-versus-opaque question for a host type,
 * and it is asked of the CHECKER rather than of a table. A hand-maintained list
 * of "constructible host types" would be a second authority over a question the
 * declaration already answers, and it would drift the first time the host grew
 * a method.
 */
export const isDataOnlyObjectShape = (
  shape: StructuralShape | null,
  shapeOf: (id: StructuralTypeId) => StructuralShape | null
): boolean => {
  if (shape?.kind !== 'object') return false
  // `membersDropped` is the whole reason this is not simply a scan of
  // `members`: an ambient body arrives already filtered to its data, so a
  // host interface of pure methods reads as "no callable members" unless the
  // projection itself disqualifies it.
  if (shape.membersDropped) return false
  if (shape.members.length === 0 || shape.index.length > 0) return false
  return shape.members.every((member) => member.accessor === null && shapeOf(member.type)?.kind !== 'signature')
}
