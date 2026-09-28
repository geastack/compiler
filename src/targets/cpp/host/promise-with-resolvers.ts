import type { DeclarationId } from '../../../identity/ids.js'
import type { ClassLayout } from '../../../projection/classes.js'
import { declaredRecordFieldOf } from '../../../projection/fields.js'
import type { RepresentationDeriver } from '../../../representation/derive.js'
import { representationKey, type Representation } from '../../../representation/model.js'
import { cppRecordFieldName, cppRecordStructName, cppResultTypeOf, cppTypeOf } from '../types.js'

/**
 * `Promise.withResolvers()` (ECMA-262 27.2.4.8, NewPromiseCapability over
 * %Promise%): a pending promise and the two resolving functions a
 * `new Promise(executor)` hands its executor -- the same
 * `ResolverFactory`/`RejecterFactory` closures -- stored in the record
 * `result` lays out. `null` when `result` is not a shared record with required
 * `promise`, `resolve` and `reject` fields of their own kinds or boxes.
 *
 * The call and the method read as a value (fastify's
 * `Promise.withResolvers.bind(Promise)`) both build it from here, one over the
 * call's result and one over its callable's.
 */
export const withResolversRecordText = (
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  result: Representation
): string | null => {
  if (
    (result.kind !== 'record' && !(result.kind === 'native-record-ref' && result.native === null)) ||
    result.ownership !== 'shared-refcount'
  )
    return null
  const field = (name: string): Representation | null => {
    const declared = declaredRecordFieldOf(deriver, result, name, classes)
    return declared && declared.required ? declared.value : null
  }
  const promise = field('promise')
  const resolve = field('resolve')
  const reject = field('reject')
  // A field the record holds as a box takes the same promise or resolving
  // function boxed: a `Promise<Value>` and `(value) => void` over it.
  const settles = (carrier: Representation | null): boolean => carrier?.kind === 'function-value-dispatch' || carrier?.kind === 'dynamic'
  if ((promise?.kind !== 'promise' && promise?.kind !== 'dynamic') || !settles(resolve) || !settles(reject)) return null
  const payload: Representation = promise.kind === 'promise' ? promise.value : promise
  const value = cppResultTypeOf(payload)
  const factories = 'gea::host::PromiseConstructor'
  const boxedSettle = 'gea::CallableObject<void(gea::Value)>'
  const settleType = (carrier: Representation): string => (carrier.kind === 'dynamic' ? boxedSettle : cppTypeOf(carrier))
  const boxedIn = (carrier: Representation, text: string): string =>
    carrier.kind === 'dynamic' ? `gea::Value::boxMethod<-1>(${text})` : text
  const resolver = boxedIn(
    resolve!,
    payload.kind === 'void'
      ? `${factories}::VoidResolverFactory<${settleType(resolve!)}>::make(__gea_promise)`
      : `${factories}::ResolverFactory<${settleType(resolve!)}, ${value}>::make(__gea_promise)`
  )
  const rejecter = boxedIn(reject!, `${factories}::RejecterFactory<${settleType(reject!)}, ${value}>::make(__gea_promise)`)
  const held = promise.kind === 'dynamic' ? `gea::detail::DynamicCarrier<gea::Promise<${value}>>::out(__gea_promise)` : '__gea_promise'
  return (
    `([&]() { gea::Promise<${value}> __gea_promise; auto __gea_record = gea::makeRef<${cppRecordStructName(result.shapeId)}>(); ` +
    `__gea_record->${cppRecordFieldName('promise')} = ${held}; ` +
    `__gea_record->${cppRecordFieldName('resolve')} = ${resolver}; ` +
    `__gea_record->${cppRecordFieldName('reject')} = ${rejecter}; return __gea_record; })()`
  )
}

/** Why `withResolversRecordText` builds nothing for `result`: the field that is missing or of another kind. */
export const withResolversRecordRefusal = (
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  result: Representation
): string => {
  if (
    (result.kind !== 'record' && !(result.kind === 'native-record-ref' && result.native === null)) ||
    result.ownership !== 'shared-refcount'
  )
    return `the result is carried as "${representationKey(result)}", not a shared record`
  const fields = ['promise', 'resolve', 'reject'].map((name) => {
    const declared = declaredRecordFieldOf(deriver, result, name, classes)
    return `${name}: ${declared === null ? 'absent' : `${declared.required ? '' : 'optional '}${representationKey(declared.value)}`}`
  })
  return `its fields are ${fields.join('; ')} -- a required promise (or box) and two resolving functions (or boxes) are what it builds`
}
