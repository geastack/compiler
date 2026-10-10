// A conversion whose text depends only on its carriers is defined ONCE per
// translation unit and called by name at every site that needs it.
//
// Each of these used to be pasted in full at every use: an `any -> record`
// load as an immediately invoked lambda building its live Document view with
// all five field adapters,
// `Object.assign` between two known shapes as a static copy plus a
// creation-order walk routing every run-time key through the target's field
// list, a spread's run-time key routing the same way, and `Object.entries` of
// a known shape as a push per field. A database client's 131-field options family made
// each copy tens of kilobytes; the ping driver's unit was 77 MB with lines of
// 390 KB. The assertions below pin that each renders once however many sites
// ask for it, and the run pins that calling the one definition still answers
// what node answers at every site.
//
//! emitted-lacks: [](const gea::Value& gea_dynamic_record)
//! emitted-once: gea::record::makeDocumentViewWithOrigin<
//! emitted-once: gea::assignOwnPropertiesUnorderedWith(gea_assign_source,
//! emitted-has: gea::nativeObjectDataSet<
//! emitted-once: if (gea_spread_key == "alpha")
//! emitted-once: gea::copyOwnPropertiesInCreationOrder(gea_entries_source,
//! expect: first 1 x
//! expect: second 2 y
//! expect: third 3 undefined
//! expect: assigned 1 x 10
//! expect: again 2 y 10
//! expect: listed alpha,delta,beta
//! expect: spread 1 x
//! expect: spread again 2 y
//! expect: entries alpha=1,beta=x
//! expect: entries again alpha=2,beta=y,gamma=true
//! expect: source (): string => 'é😀'
//! expect: 26
interface Settings {
  alpha: number
  beta?: string
  gamma?: boolean
}

interface Wider {
  alpha: number
  beta?: string
  gamma?: boolean
  delta?: number
}

const firstDocument: any = { alpha: 1, beta: 'x' }
const secondDocument: any = { alpha: 2, beta: 'y', gamma: true }
const thirdDocument: any = { alpha: 3 }
const load = (document: any): Settings => document as Settings
const first = load(firstDocument)
const second = secondDocument as Settings
const third: Settings = thirdDocument
console.log('first', first.alpha, first.beta)
console.log('second', second.alpha, second.beta)
console.log('third', third.alpha, third.beta)

const assigned: Wider = { alpha: 0, delta: 10 }
Object.assign(assigned, first)
console.log('assigned', assigned.alpha, assigned.beta, assigned.delta)
const again: Wider = { alpha: 0, delta: 10 }
Object.assign(again, second)
console.log('again', again.alpha, again.beta, again.delta)

// `Listed` has no `gamma`, which `Settings` declares: a typed key the
// target's layout lacks lands in its native object data, never a box. `first`
// is no closed literal family, so its own carrier describes its keys, read
// in its own key order (a Document view's entries included).
interface Listed {
  alpha: number
  beta?: string
  delta?: number
}
const listed: Listed = { alpha: 0, delta: 10 }
Object.assign(listed, first)
console.log('listed', Object.keys(listed).join(','))

const spreadOf = (from: Settings): Settings => ({ ...from })
const spread = spreadOf(first)
console.log('spread', spread.alpha, spread.beta)
const spreadAgain = { ...second }
console.log('spread again', spreadAgain.alpha, spreadAgain.beta)

const entriesOf = (from: Settings): string =>
  Object.entries(from)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(',')
console.log('entries', entriesOf(first))
console.log(
  'entries again',
  Object.entries(second)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(',')
)

// A function's source text is spelled once however many sites mint it, and
// its stated length is the literal's UTF-8 byte count, astral and accented
// characters included.
const accent = (): string => 'é😀'
const show = (value: any): string => 'source ' + value
console.log(show(accent))
console.log(show(accent).length)
