import type { DeclarationId, FunctionId } from '../../identity/ids.js'
import type { CallableAbi, Representation } from '../../representation/model.js'
import { representationKey } from '../../representation/model.js'
import type { ClassLayout } from '../../projection/classes.js'
import { alignedValueText, type ConversionSite } from './emit-narrowing.js'
import { cppBodyName, cppRecordFieldName, cppRecordFieldPresenceName, cppTypeOf } from './types.js'

/** One argument reaching a native collection base, already rendered as C++. */
export interface NativeCollectionBaseArgument {
  readonly representation: Representation
  readonly text: string
}

type Collection = Extract<Representation, { readonly kind: 'keyed-collection' }>

/** The class method a collection constructor's `adder` lookup finds on the receiver, when the program declares one. */
interface ClassAdder {
  readonly callable: FunctionId
  readonly abi: CallableAbi
}

/**
 * What `super(iterable)` adds each element through.
 *
 * ECMA-262 24.1.1.1 step 5 / 24.2.1.1 step 5 read the adder (`set` for a map,
 * `add` for a set) off the NEW object, so a class that redeclares it has its
 * own method called for every entry -- `CaseInsensitiveMap`'s `set`
 * lower-cases each key the constructor was given. The nearest declaration
 * from the constructing class up is that method; with none, the adder is the
 * native collection's own. A class DERIVED from the constructing one that
 * redeclares the adder would be the one called for its own instances, which a
 * direct call cannot select, so that refuses.
 */
const adderOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  owning: DeclarationId,
  family: Collection['family'],
  abiOf: (callable: FunctionId) => CallableAbi | null
): ClassAdder | null | string => {
  const name = family === 'map' || family === 'weak-map' ? 'set' : 'add'
  const inheritsFrom = (layout: ClassLayout): boolean => {
    const seen = new Set<DeclarationId>()
    for (let current = layout.base; current !== null && !seen.has(current); current = classes.get(current)?.base ?? null) {
      seen.add(current)
      if (current === owning) return true
    }
    return false
  }
  for (const layout of classes.values()) {
    if (inheritsFrom(layout) && layout.methods.some((method) => method.key === name)) {
      return `class ${layout.declaration} redeclares "${name}", which a ${family} base's constructor calls for every entry of its own instances`
    }
  }
  const seen = new Set<DeclarationId>()
  for (let current: DeclarationId | null = owning; current !== null && !seen.has(current); current = classes.get(current)?.base ?? null) {
    seen.add(current)
    const method = classes.get(current)?.methods.find((candidate) => candidate.key === name)
    if (method === undefined) continue
    if (method.callable === null) return `class ${current}'s "${name}" has no body for a ${family} base's constructor to call`
    const abi = abiOf(method.callable)
    if (abi === null) return `class ${current}'s "${name}" body ${method.callable} published no callable ABI`
    return { callable: method.callable, abi }
  }
  return null
}

/**
 * `super(iterable)` against a native `Map`/`Set`/`WeakMap`/`WeakSet` base, as
 * statements run on a receiver that already exists -- shared by a written
 * `super(...)` and the implicit `constructor(...args) { super(...args) }` for
 * `native-error-base.ts`'s reason: they are one language step.
 *
 * ECMA-262 24.1.1.1 / 24.2.1.1: an absent, `undefined` or `null` iterable adds
 * nothing; otherwise each element goes through the adder (`adderOf`).
 *
 * The iterable is walked statically, so only an array whose elements are the
 * collection's key (a set) or `[key, value]` pair records (a map) is admitted;
 * any other iterable refuses by name.
 */
export const nativeCollectionBaseInitializeStatements = (
  site: ConversionSite,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  owning: DeclarationId,
  abiOf: (callable: FunctionId) => CallableAbi | null,
  receiverName: string,
  base: Collection,
  args: readonly (NativeCollectionBaseArgument | undefined)[]
): readonly string[] | string => {
  const iterable = args[0]
  if (iterable === undefined) return []
  const carrier = iterable.representation
  if (carrier.kind === 'undefined' || carrier.kind === 'null') return []
  const adder = adderOf(classes, owning, base.family, abiOf)
  if (typeof adder === 'string') return adder
  const add = adderText(site, receiverName, base, adder)
  if (carrier.kind === 'optional') {
    const seeded = seedStatement(base, carrier.payload, `(*${iterable.text})`, add)
    return 'refused' in seeded ? seeded.refused : [`if (${iterable.text}.has_value()) ${seeded.statement}`]
  }
  if (carrier.kind === 'tagged-union') {
    // The frame an implicit constructor inherits is the collection
    // constructor's widest overload, so its argument is a union the runtime
    // dispatches on. An arm whose iterable this backend cannot walk
    // statically refuses when -- and only when -- a value of it arrives.
    const lines: string[] = []
    carrier.arms.forEach((arm, index) => {
      if (arm.value.kind === 'undefined' || arm.value.kind === 'null') return
      const seeded = seedStatement(base, arm.value, `${iterable.text}.get<${index}>()`, add)
      if ('refused' in seeded) {
        lines.push(`if (${iterable.text}.is<${index}>()) gea::detail::refuseUnloweredCollectionSeed(${JSON.stringify(seeded.refused)});`)
        return
      }
      lines.push(`if (${iterable.text}.is<${index}>()) ${seeded.statement}`)
    })
    return lines
  }
  const seeded = seedStatement(base, carrier, iterable.text, add)
  return 'refused' in seeded ? seeded.refused : [seeded.statement]
}

interface Operand {
  readonly representation: Representation
  readonly text: string
}

type Seeded = { readonly statement: string } | { readonly refused: string }

/** One call of the adder with operands already read out of an element, or why their carriers do not reach it. */
type AddText = (operands: readonly Operand[]) => Seeded

const adderText =
  (site: ConversionSite, receiverName: string, base: Collection, adder: ClassAdder | null): AddText =>
  (operands) => {
    if (adder === null) {
      // The native adder takes exactly the collection's own carriers.
      const expected = base.value === null ? [base.key] : [base.key, base.value]
      const mismatch = operands.findIndex((operand, index) => {
        const want = expected[index]
        return want === undefined || representationKey(operand.representation) !== representationKey(want)
      })
      if (mismatch >= 0 || operands.length !== expected.length) {
        return {
          refused:
            `a ${base.family}<${expected.map(representationKey).join(', ')}> base seeded from entries carried as ` +
            `[${operands.map((operand) => representationKey(operand.representation)).join(', ')}]`
        }
      }
      const target = `static_cast<${cppTypeOf({ ...base, ownership: 'owned' })}&>(*${receiverName})`
      return { statement: `${target}.${base.value === null ? 'add' : 'set'}(${operands.map((operand) => operand.text).join(', ')});` }
    }
    if (adder.abi.parameters.length < operands.length) {
      return {
        refused: `the class adder ${adder.callable} declares ${adder.abi.parameters.length} parameter(s) for ${operands.length} entry part(s)`
      }
    }
    const actuals: string[] = []
    for (const [index, operand] of operands.entries()) {
      const parameter = adder.abi.parameters[index]!.value
      const text = alignedValueText(site, 'native-collection-base.ts:adder', operand.representation, parameter, operand.text)
      if (text === null) {
        return {
          refused: `an entry part carried as "${representationKey(operand.representation)}" does not reach the class adder's parameter "${representationKey(parameter)}"`
        }
      }
      actuals.push(text)
    }
    if (adder.abi.parameters.length > operands.length) {
      return {
        refused: `the class adder ${adder.callable} declares ${adder.abi.parameters.length} parameter(s), more than an entry supplies`
      }
    }
    return { statement: `(void)${cppBodyName(adder.callable)}(${[receiverName, ...actuals].join(', ')});` }
  }

/** One statement adding every element of an iterable carried as `source`, or why it cannot. */
const seedStatement = (base: Collection, source: Representation, sourceText: string, add: AddText): Seeded => {
  if (source.kind !== 'array-object') {
    return {
      refused: `a ${base.family} base seeded from "${representationKey(source)}" needs the @@iterator protocol this backend does not lower`
    }
  }
  const element = source.element
  if (base.family === 'set' || base.family === 'weak-set') {
    const added = add([{ representation: element, text: 'gea_slot.value' }])
    if ('refused' in added) return added
    return {
      statement: `for (const auto& gea_slot : ${sourceText}->readSlots()) { if (!gea_slot.present) gea::host::throwRuntimeError("TypeError", "a hole is not a set element"); ${added.statement} }`
    }
  }
  // A `[K | V, K | V]` tuple whose two positions share one union is carried as
  // an ARRAY of that union, not a pair record (a bidirectional enum map's
  // `[name, value]` entries).
  // 24.1.1.2 AddEntriesFromIterable reads `"0"` and `"1"` off each item all
  // the same; a missing one is the `undefined` this carrier cannot hold, which
  // stops loudly rather than inventing a key.
  if (element.kind === 'array-object') {
    const added = add([
      { representation: element.element, text: 'gea_slot.value->readElementAtIndex(0)' },
      { representation: element.element, text: 'gea_slot.value->readElementAtIndex(1)' }
    ])
    if ('refused' in added) return added
    const short = JSON.stringify(
      `a ${base.family} entry without both a key and a value would bind undefined, which its carrier cannot hold`
    )
    return {
      statement:
        `for (const auto& gea_slot : ${sourceText}->readSlots()) { ` +
        `if (!gea_slot.present) gea::host::throwRuntimeError("TypeError", "Iterator value is not an entry object"); ` +
        `if (!gea_slot.value->hasElementValueAtIndex(0) || !gea_slot.value->hasElementValueAtIndex(1)) gea::detail::refuseUnloweredCollectionSeed(${short}); ` +
        `${added.statement} }`
    }
  }
  const pair = pairFieldsOf(element)
  if (pair === null) {
    return {
      refused: `a ${base.family} base seeded from elements carried as "${representationKey(element)}", which is not a [key, value] pair record`
    }
  }
  const access = memberAccess(element)
  const added = add([
    { representation: pair.key.value, text: `gea_slot.value${access}${cppRecordFieldName('0')}` },
    { representation: pair.value.value, text: `gea_slot.value${access}${cppRecordFieldName('1')}` }
  ])
  if ('refused' in added) return added
  const absent = [pair.key, pair.value]
    .filter((field) => !field.required)
    .map((field) => ` || !gea_slot.value${access}${cppRecordFieldPresenceName(field.key)}`)
    .join('')
  return {
    statement:
      `for (const auto& gea_slot : ${sourceText}->readSlots()) { ` +
      `if (!gea_slot.present${absent}) gea::host::throwRuntimeError("TypeError", "Iterator value is not an entry object"); ` +
      `${added.statement} }`
  }
}

interface PairField {
  readonly key: string
  readonly value: Representation
  readonly required: boolean
}

const pairFieldsOf = (element: Representation): { readonly key: PairField; readonly value: PairField } | null => {
  if (element.kind !== 'record') return null
  const key = element.fields.find((field) => field.key === '0')
  const value = element.fields.find((field) => field.key === '1')
  return key && value ? { key, value } : null
}

const memberAccess = (element: Representation): string => ('ownership' in element && element.ownership === 'shared-refcount' ? '->' : '.')
