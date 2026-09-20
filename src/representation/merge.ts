import type { StructuralTypeId } from '../identity/ids.js'
import type { SemanticOperand } from '../semantics/model/operands.js'
import type { StructuralType } from '../semantics/model/structural-types.js'
import type { RepresentationDeriver } from './derive.js'
import { carriesMergeAbsence, carriesUndefined, contributesOnlyAbsence, type Representation } from './model.js'

/** The exact value retained by an object-shaped falsy `&&` operand.
 * An explicitly tagged destination must preserve null versus undefined.
 * This is branch-local materialization, never a general object conversion.
 */
export const mergeTaggedAbsence = (source: Representation, target: Representation): 'null' | 'undefined' | null => {
  if (target.kind !== 'tagged-union') return null
  const absence =
    source.kind === 'optional'
      ? source.absence
      : source.kind === 'native-handle' || (source.kind === 'class-ref' && source.ownership === 'shared-refcount')
        ? 'null'
        : null
  return absence && target.arms.some((arm) => arm.value.kind === absence) ? absence : null
}

export const mergeFalsyAbsence = (source: Representation, target: Representation): 'null' | 'undefined' | null =>
  contributesOnlyAbsence(source) ? mergeTaggedAbsence(source, target) : null

/**
 * A merge can construct these values in its own carrier without converting an
 * incoming carrier. Preflight and lowering must ask the same question: a
 * `never[]` arm contains no elements, whereas `void[]` and `undefined[]` may
 * contain real entries even though their element types occupy no storage.
 */
export const mergeMaterialization = (
  types: ReadonlyMap<StructuralTypeId, StructuralType>,
  deriver: RepresentationDeriver,
  operand: SemanticOperand,
  target: Representation
): 'constant' | 'empty-array' | 'absence' | 'unreachable' | null => {
  if (operand.source.kind === 'constant' && deriver.derive(operand.type).kind === 'void') return 'constant'
  const shape = types.get(operand.type)?.shape
  // A non-constant expression typed `never` cannot complete normally, so its
  // branch contributes no runtime value to the phi. When the destination has
  // an absence state, materialize that state solely to give C++ a typed
  // incoming expression for the unreachable edge. Otherwise the edge gets an
  // unreachable value of the merge's own carrier: `k === 0 ? a : k === 1 ? b
  // : Debug.fail()` is tsc's standing idiom (17 rows on the self-compile),
  // and its last arm never delivers anything to convert. Both are
  // branch-local: neither installs a general `void -> object` conversion.
  if (shape?.kind === 'primitive' && shape.primitive === 'never') return carriesMergeAbsence(target) ? 'absence' : 'unreachable'
  // A `void` call as a default (`[w = counter()]`) publishes no value at all;
  // what the merge receives from that arm is `undefined`, spelled in the
  // target's own absence -- the call itself still runs in the arm.
  if (shape?.kind === 'primitive' && (shape.primitive === 'void' || shape.primitive === 'undefined') && carriesUndefined(target))
    return 'absence'
  if (holdsEmptyArray(types, target) && isEmptyArrayLiteralType(deriver, shape)) return 'empty-array'
  return null
}

/**
 * The type of an array literal with no elements, in the two spellings the
 * checker gives one.
 *
 * This is the same pair `semantics/normalize/structural.ts` recognizes when it
 * DROPS an empty-array arm out of a union -- "13.2.4.2 gives an ArrayLiteral
 * with no elements an Array of length 0, and a value with no element cannot
 * disagree with any element type, so it is already a value of the arm beside
 * it". That drop is what makes `path.match(re) || []` publish the surviving
 * arm's carrier alone, so the two have to admit the identical set: an arm the
 * join removes and this does not recognize is a merge with no incoming value
 * at all.
 *
 * Both spellings really occur, decided by what contextually types the literal:
 * `input || []` against a `string[]` gets the array shape, while `path.match(re)
 * || []` gets the empty TUPLE, because `RegExpMatchArray` is an array-LIKE with
 * members of its own rather than an `Array<T>`. Only the array-of-never
 * spelling was admitted, so the tuple one refused.
 */
const isEmptyArrayLiteralType = (deriver: RepresentationDeriver, shape: StructuralType['shape'] | undefined): boolean =>
  shape?.kind === 'tuple' ? shape.elements.length === 0 : shape?.kind === 'array' && deriver.isNeverType(shape.element)

/**
 * A carrier an empty array can be BUILT in, rather than converted into.
 *
 * `array-object` is the obvious one. The other is a stated-native record whose
 * structural shape is an array: `RegExpMatchArray` is `gea::runtime::regex::
 * MatchResult`, which IS a `gea::ArrayObject<std::string>` carrying the members
 * 22.1.3.13 adds beside it, all of them default-initialized. An empty one is
 * therefore constructible and is exactly the `[]` the program wrote -- the same
 * `[]` TypeScript itself already accepts here, `RegExpMatchArray`'s required
 * `[0]` notwithstanding, because an empty array disagrees with no element type.
 *
 * Asked of the target's own shape rather than of a list of native names: the
 * fact that licenses the construction is "this carrier holds an array", and a
 * name list would be a second authority over the same question that drifts the
 * first time a host states another array-like type.
 */
const holdsEmptyArray = (types: ReadonlyMap<StructuralTypeId, StructuralType>, target: Representation): boolean =>
  target.kind === 'array-object' ||
  (target.kind === 'native-record-ref' && types.get(target.shapeId as StructuralTypeId)?.shape.kind === 'array')
