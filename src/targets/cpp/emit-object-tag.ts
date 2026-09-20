import { representationKey, type Representation } from '../../representation/model.js'
import { disjointNativeRecordIndexOf } from '../../ir/native-record-index.js'
import type { EmitContext } from './emit-context.js'
import { cppRecordIndexSidecarNameFor, recordIndexesOfShape } from './records.js'
import { cppStringLiteral } from './types.js'
import { binaryToStringTagText } from './emit-buffers.js'
import { cppDateType } from './prototype/emit-prototype-date.js'
import { cppErrorNativeType } from './error-types.js'
import { cppRegExpNativeTypes, cppStringObjectNativeType } from './regexp-types.js'

/** Object.prototype.toString's builtin brand, followed by its ordinary @@toStringTag lookup. */
const nativeTagValueText = (rep: Representation, value: string): string => {
  if (rep.kind === 'string') return `(std::string("[object ") + ${value} + "]")`
  if (rep.kind === 'dynamic') return `gea::objectTagWithOverride(${value}, "Object")`
  if (rep.kind === 'optional')
    return `(${value}.has_value() ? ${nativeTagValueText(rep.payload, `(*${value})`)} : gea::objectTagText("Object"))`
  if (rep.kind === 'tagged-union')
    return `(${rep.arms
      .map((arm, index) => `${value}.is<${index}>() ? ${nativeTagValueText(arm.value, `${value}.get<${index}>()`)} : `)
      .join('')}gea::objectTagText("Object"))`
  return 'gea::objectTagText("Object")'
}

export const objectTagExpression = (rep: Representation, value: string, ctx?: EmitContext): string | null => {
  if ('ownership' in rep && rep.ownership !== 'shared-refcount') return null
  if (rep.kind === 'function-value-dispatch' && rep.recursive) return null
  const tag = (builtin: string, fallback?: string): string =>
    `gea::objectTag(${value}, ${cppStringLiteral(builtin)}${fallback ? `, ${cppStringLiteral(fallback)}` : ''})`
  if (rep.kind === 'optional') {
    const payload = objectTagExpression(rep.payload, `(*${value})`, ctx)
    return payload === null
      ? null
      : `(${value}.has_value() ? ${payload} : std::string("[object ${rep.absence === 'null' ? 'Null' : 'Undefined'}]"))`
  }
  if (rep.kind === 'tagged-union') {
    const arms = rep.arms.map((arm, index) => objectTagExpression(arm.value, `${value}.get<${index}>()`, ctx))
    if (arms.length === 0 || arms.some((arm) => arm === null)) return null
    return `(${arms
      .slice(0, -1)
      .map((arm, index) => `${value}.is<${index}>() ? ${arm} : `)
      .join('')}${arms.at(-1)})`
  }
  if (ctx && (rep.kind === 'record-with-index' || (rep.kind === 'native-record-ref' && rep.native === null))) {
    const index = disjointNativeRecordIndexOf(ctx.deriver, rep, { kind: 'symbol' })
    if (index) {
      const indexes = rep.kind === 'record-with-index' ? rep.indexes : recordIndexesOfShape(ctx.deriver, rep.shapeId)
      const member = cppRecordIndexSidecarNameFor(index, indexes)
      return (
        `([&]() -> std::string { const auto& __gea_object = ${value}; if (!__gea_object) return gea::objectTagText("Null"); ` +
        `const auto __gea_key = gea::wellKnownSymbol(gea::detail::WellKnownSymbol::ToStringTag); ` +
        `if (__gea_object->${member}.has(__gea_key)) { const auto& __gea_tag = __gea_object->${member}.read(__gea_key); ` +
        `return ${nativeTagValueText(index.value, '__gea_tag')}; } return gea::objectTag(__gea_object, "Object"); })()`
      )
    }
  }
  if (rep.kind === 'null') return 'std::string("[object Null]")'
  if (rep.kind === 'undefined' || rep.kind === 'void') return 'std::string("[object Undefined]")'
  if (rep.kind === 'scalar') return rep.domain === 'bigint' ? tag('Object', 'BigInt') : tag(rep.domain === 'boolean' ? 'Boolean' : 'Number')
  if (rep.kind === 'string') return tag('String')
  if (rep.kind === 'symbol') return tag('Object', 'Symbol')
  if (rep.kind === 'dynamic') return tag('Object')
  if (rep.kind === 'array-object') return tag('Array')
  if (rep.kind === 'native-handle') {
    if (rep.protocol === 'Math') return 'gea::hostIntrinsicObjectTag("Math", "Object", "Math")'
    if (rep.call || rep.construct) return `gea::hostIntrinsicObjectTag(${cppStringLiteral(rep.protocol)}, "Function")`
    return null
  }
  if (rep.kind === 'native-record-ref') {
    if (rep.native === cppDateType) return tag('Date')
    if (rep.native === cppErrorNativeType) return tag('Error')
    if (rep.native === cppRegExpNativeTypes.pattern) return tag('RegExp')
    if (rep.native === cppStringObjectNativeType) return tag('String')
    return rep.native === null ? tag('Object') : null
  }
  if (rep.kind === 'keyed-collection')
    return tag('Object', { map: 'Map', set: 'Set', 'weak-map': 'WeakMap', 'weak-set': 'WeakSet' }[rep.family])
  const binaryTag = binaryToStringTagText(rep)
  if (binaryTag !== null) return `gea::objectTag(${value}, "Object", ${binaryTag})`
  switch (rep.kind) {
    case 'record':
    case 'record-with-index':
    case 'class-ref':
    case 'dictionary':
      return tag('Object')
    case 'function':
    case 'function-family':
    case 'function-value-family':
    case 'function-value-dispatch':
    case 'function-and-constructor':
      return tag('Function')
    default:
      return null
  }
}

export const objectTagCapability = (rep: Representation): string => `computation:object-tag:${representationKey(rep)}`
