import type { Representation } from './model.js'
import { canonicalIndexLiteral } from './array-index.js'

/** Native prototype templates state their member domain before call certification. */
export const arrayBulkAppendMethodName = 'push'
export const arrayPrototypeMethods: ReadonlySet<string> = new Set([
  arrayBulkAppendMethodName,
  'unshift',
  'map',
  'filter',
  'forEach',
  'findIndex',
  'some',
  'every',
  'flatMap',
  'find',
  'at',
  'pop',
  'shift',
  'reduce',
  'reduceRight',
  'splice',
  'sort',
  'join',
  'toString',
  'concat',
  'flat',
  'entries',
  'keys',
  'values',
  'slice',
  'indexOf',
  'lastIndexOf',
  'includes',
  'fill',
  'reverse'
])

export interface StringMethodShape {
  readonly clause: string
  readonly arities: readonly number[]
  /** The carrier each positional argument must have, by ordinal. */
  readonly carriers: readonly ('string' | 'number')[]
  /** The `gea::runtime::string` function, when it is not the member's own name. */
  readonly spelling?: string
}

export const stringMethodShapes: ReadonlyMap<string, StringMethodShape> = new Map([
  ['substring', { clause: '22.1.3.24', arities: [1, 2], carriers: ['number', 'number'] }],
  ['substr', { clause: 'B.2.3.1', arities: [1, 2], carriers: ['number', 'number'] }],
  ['slice', { clause: '22.1.3.22', arities: [1, 2], carriers: ['number', 'number'] }],
  ['trim', { clause: '22.1.3.32', arities: [0], carriers: [] }],
  ['trimStart', { clause: '22.1.3.34', arities: [0], carriers: [] }],
  ['trimEnd', { clause: '22.1.3.33', arities: [0], carriers: [] }],
  ['toLowerCase', { clause: '22.1.3.29', arities: [0], carriers: [] }],
  ['toUpperCase', { clause: '22.1.3.31', arities: [0], carriers: [] }],
  ['charCodeAt', { clause: '22.1.3.3', arities: [1], carriers: ['number'] }],
  ['charAt', { clause: '22.1.3.2', arities: [1], carriers: ['number'] }],
  ['indexOf', { clause: '22.1.3.9', arities: [1, 2], carriers: ['string', 'number'] }],
  ['lastIndexOf', { clause: '22.1.3.10', arities: [1, 2], carriers: ['string', 'number'] }],
  ['includes', { clause: '22.1.3.8', arities: [1, 2], carriers: ['string', 'number'] }],
  ['startsWith', { clause: '22.1.3.23', arities: [1, 2], carriers: ['string', 'number'] }],
  ['endsWith', { clause: '22.1.3.7', arities: [1, 2], carriers: ['string', 'number'] }],
  ['padStart', { clause: '22.1.3.16', arities: [1, 2], carriers: ['number', 'string'] }],
  ['padEnd', { clause: '22.1.3.15', arities: [1, 2], carriers: ['number', 'string'] }],
  ['repeat', { clause: '22.1.3.17', arities: [1], carriers: ['number'] }],
  ['localeCompare', { clause: '22.1.3.12', arities: [1], carriers: ['string'] }],
  // The three members `lib.es5.d.ts` declares over `string | RegExp`. These
  // rows are the STRING form only; the pattern form is rendered by
  // `emit-prototype-regexp.ts` and asked first (see `shapedStringMethodText`).
  ['split', { clause: '22.1.3.21', arities: [1], carriers: ['string'] }],
  ['replace', { clause: '22.1.3.18', arities: [2], carriers: ['string', 'string'] }],
  ['replaceAll', { clause: '22.1.3.20', arities: [2], carriers: ['string', 'string'] }]
])

export const stringPrototypeMethods: ReadonlySet<string> = new Set([
  'concat',
  'toString',
  'valueOf',
  'normalize',
  'match',
  'search',
  'at',
  'codePointAt',
  ...stringMethodShapes.keys()
])

/** Intrinsic String prototype member names, including unimplemented Unicode/locale and Annex B members. */
export const declaredStringPrototypeMemberNames: ReadonlySet<string> = new Set([
  ...stringPrototypeMethods,
  'constructor',
  'length',
  'trimLeft',
  'trimRight',
  'matchAll',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'isWellFormed',
  'toWellFormed',
  'anchor',
  'big',
  'blink',
  'bold',
  'fixed',
  'fontcolor',
  'fontsize',
  'italics',
  'link',
  'small',
  'strike',
  'sub',
  'sup'
])

export const cppDateType = 'gea::runtime::Date'

export const isDateCarrier = (representation: Representation): representation is Extract<Representation, { kind: 'native-record-ref' }> =>
  representation.kind === 'native-record-ref' && representation.native === cppDateType

export const dateGetters: readonly string[] = [
  'getTime',
  'valueOf',
  'getFullYear',
  'getMonth',
  'getDate',
  'getDay',
  'getHours',
  'getMinutes',
  'getSeconds',
  'getMilliseconds',
  'getTimezoneOffset',
  'getUTCFullYear',
  'getUTCMonth',
  'getUTCDate',
  'getUTCDay',
  'getUTCHours',
  'getUTCMinutes',
  'getUTCSeconds',
  'getUTCMilliseconds'
]

/** The zero-argument string forms. `toLocale*` are not here: they take arguments this backend refuses rather than ignores. */
export const dateStringForms: readonly string[] = ['toISOString', 'toString', 'toDateString', 'toTimeString', 'toUTCString']

/** Each setter, with the maximum number of arguments `lib.es5.d.ts` declares for it. */
export const dateSetters: ReadonlyMap<string, number> = new Map([
  ['setTime', 1],
  ['setFullYear', 3],
  ['setMonth', 2],
  ['setDate', 1],
  ['setHours', 4],
  ['setMinutes', 3],
  ['setSeconds', 2],
  ['setMilliseconds', 1],
  ['setUTCFullYear', 3],
  ['setUTCMonth', 2],
  ['setUTCDate', 1],
  ['setUTCHours', 4],
  ['setUTCMinutes', 3],
  ['setUTCSeconds', 2],
  ['setUTCMilliseconds', 1]
])

export const datePrototypeMethods: ReadonlySet<string> = new Set([
  ...dateGetters,
  ...dateStringForms,
  ...dateSetters.keys(),
  'toLocaleString',
  'toLocaleDateString',
  'toLocaleTimeString',
  'toJSON'
])
export const cppErrorNativeType = 'gea::runtime::Error'
export const isNativeError = (carrier: Representation): boolean =>
  carrier.kind === 'native-record-ref' && carrier.native === cppErrorNativeType && carrier.ownership === 'shared-refcount'
export const errorPrototypeMethods: ReadonlySet<string> = new Set(['toString'])
export const promisePrototypeMethods: ReadonlySet<string> = new Set(['then', 'catch', 'finally', 'toString'])
export const numberPrototypeMethods: ReadonlySet<string> = new Set(['toFixed', 'toExponential', 'toPrecision', 'toString', 'valueOf'])
export const dictionaryPrototypeMethods: ReadonlySet<string> = new Set(['hasOwnProperty'])
export const iteratorPrototypeMethods: ReadonlySet<string> = new Set(['next', 'return', 'throw'])
export const typedArrayPrototypeMethods: ReadonlySet<string> = new Set(['set', 'subarray', 'slice', 'fill', 'toString', 'toBase64'])
export const dataViewPrototypeMethods: ReadonlySet<string> = new Set([
  ...['get', 'set'].flatMap((operation) =>
    ['Int8', 'Uint8', 'Int16', 'Uint16', 'Int32', 'Uint32', 'Float32', 'Float64'].map((type) => `${operation}${type}`)
  )
])

const strongMapMethods: ReadonlySet<string> = new Set(['get', 'set', 'has', 'delete', 'clear', 'entries', 'keys', 'values'])
const strongSetMethods: ReadonlySet<string> = new Set(['add', 'has', 'delete', 'clear', 'forEach'])
const weakMapMethods: ReadonlySet<string> = new Set(['get', 'set', 'has', 'delete'])
const weakSetMethods: ReadonlySet<string> = new Set(['add', 'has', 'delete'])

export type KeyedCollectionFamilyTag = 'map' | 'set' | 'weak-map' | 'weak-set'

export const keyedCollectionPrototypeMethods = (family: KeyedCollectionFamilyTag): ReadonlySet<string> =>
  family === 'map' ? strongMapMethods : family === 'set' ? strongSetMethods : family === 'weak-map' ? weakMapMethods : weakSetMethods

/** All intrinsic collection members, including members not rendered as calls. */
export const keyedCollectionIntrinsicMembers: Readonly<Record<KeyedCollectionFamilyTag, ReadonlySet<string>>> = {
  map: new Set(['clear', 'delete', 'entries', 'forEach', 'get', 'has', 'keys', 'set', 'size', 'values']),
  set: new Set([
    'add',
    'clear',
    'delete',
    'difference',
    'entries',
    'forEach',
    'has',
    'intersection',
    'isDisjointFrom',
    'isSubsetOf',
    'isSupersetOf',
    'keys',
    'size',
    'symmetricDifference',
    'union',
    'values'
  ]),
  'weak-map': new Set(['delete', 'get', 'has', 'set']),
  'weak-set': new Set(['add', 'delete', 'has'])
}

/** Native inheritance cannot be mistaken for an expando-table miss. */
export const nativeInheritedMemberOf = (value: Representation, key: string): boolean => {
  const native = value.kind === 'class-ref' ? value.nativeBase : value
  if (native === undefined) return false
  if (native.kind === 'keyed-collection') return keyedCollectionIntrinsicMembers[native.family].has(key)
  return native.kind === 'promise' && promisePrototypeMethods.has(key)
}

/** Native own layout and prototype names served before ordinary expandos. */
export const nativeIntrinsicMemberOf = (value: Representation, key: string): boolean => {
  if (nativeInheritedMemberOf(value, key)) return true
  if (value.kind === 'array-object') return key === 'length' || canonicalIndexLiteral(key) !== null || arrayPrototypeMethods.has(key)
  if (value.kind === 'typed-array')
    return (
      canonicalIndexLiteral(key) !== null ||
      typedArrayPrototypeMethods.has(key) ||
      ['buffer', 'byteLength', 'byteOffset', 'length', 'BYTES_PER_ELEMENT'].includes(key)
    )
  if (value.kind === 'array-buffer' || value.kind === 'shared-array-buffer')
    return [
      'byteLength',
      'maxByteLength',
      'resizable',
      'growable',
      'resize',
      'grow',
      'slice',
      'transfer',
      'transferToFixedLength'
    ].includes(key)
  if (value.kind === 'data-view') return ['buffer', 'byteLength', 'byteOffset'].includes(key) || dataViewPrototypeMethods.has(key)
  return false
}
