import type { Representation } from '../../representation/model.js'
import { representationKey } from '../../representation/model.js'
import type { RepresentationDeriver } from '../../representation/derive.js'
import { recordFieldsOfShape } from '../../projection/fields.js'
import { cppRecordFieldName, cppRecordFieldPresenceName } from './types.js'
import { cppErrorNativeType } from './error-types.js'

/** One argument reaching the native `Error` base, already rendered as C++. */
export interface NativeErrorBaseArgument {
  readonly representation: Representation
  readonly text: string
}

/** Why a native-`Error` base could not be initialized, in the two shapes the two call sites need. */
// Which refusal, not its key: the throw site spells each key family itself,
// because `scripts/refusal-keys.mjs` requires every family to be authored
// literally where the error is raised.
export type NativeErrorBaseRefusal =
  | { readonly refusal: 'conversion'; readonly conversion: string; readonly reason: string }
  | { readonly refusal: 'super-initialize'; readonly reason: string }

const isRefusal = (value: readonly string[] | NativeErrorBaseRefusal): value is NativeErrorBaseRefusal => !Array.isArray(value)

export const isNativeErrorBaseRefusal = isRefusal

/**
 * `super(message, options)` against the intrinsic `Error` layout, as statements
 * run on a receiver that already exists.
 *
 * This is shared by the two ways a program reaches it, because they are the
 * same language step and must not drift: a written `constructor` reaches it
 * through the `super(...)` operation, and a derived class that writes *no*
 * constructor reaches it through the implicit `constructor(...args) {
 * super(...args) }`, which the construct wrapper renders directly. A second
 * copy of this for the implicit case would be a second answer to "what does
 * ECMA-262 20.5.1.1 do", and the two would disagree the first time either
 * grew a case.
 *
 * The receiver is `static_cast` to the native base rather than reached through
 * a field: the class layout gives a derived class the base's layout as its own
 * prefix (`records.ts`'s native-base linking), so the base subobject IS the
 * receiver's front, and `initialize` writes it in place. Constructing a second
 * `gea::runtime::Error` and copying it would give the throw site a different
 * object than the one `instanceof` sees.
 */
export const nativeErrorBaseInitializeStatements = (
  deriver: RepresentationDeriver,
  receiverName: string,
  args: readonly (NativeErrorBaseArgument | undefined)[]
): readonly string[] | NativeErrorBaseRefusal => {
  const lines: string[] = []
  const message = args[0]
  let messageText = 'std::string()'
  if (message) {
    if (message.representation.kind === 'string') messageText = message.text
    else if (message.representation.kind === 'optional' && message.representation.payload.kind === 'string') {
      messageText = `(${message.text}.has_value() ? *${message.text} : std::string())`
    } else if (message.representation.kind !== 'undefined') {
      return {
        refusal: 'conversion',
        conversion: `${representationKey(message.representation)}->string`,
        reason: `intrinsic Error message carries "${representationKey(message.representation)}", not string or optional string`
      }
    }
  }
  const base = `static_cast<${cppErrorNativeType}&>(*${receiverName})`
  lines.push(`${base}.initialize(${messageText});`)
  const options = args[1]
  if (options && options.representation.kind !== 'undefined') {
    const optionsText = options.text
    const outerGuard = options.representation.kind === 'optional' ? `${optionsText}.has_value()` : null
    const payload = options.representation.kind === 'optional' ? options.representation.payload : options.representation
    const payloadText = options.representation.kind === 'optional' ? `(*${optionsText})` : optionsText
    if (payload.kind !== 'record' && payload.kind !== 'record-with-index' && payload.kind !== 'native-record-ref') {
      return {
        refusal: 'conversion',
        conversion: `${representationKey(options.representation)}->record`,
        reason: `intrinsic Error options carry "${representationKey(options.representation)}", not a static options record`
      }
    }
    const fields =
      payload.kind === 'record' || payload.kind === 'record-with-index' ? payload.fields : recordFieldsOfShape(deriver, payload.shapeId)
    const cause = fields?.find((field) => field.key === 'cause')
    if (!cause || cause.value.kind !== 'dynamic') {
      return {
        refusal: 'super-initialize',
        reason: `intrinsic Error options carry "${representationKey(options.representation)}" without a dynamic cause field`
      }
    }
    const access = payload.ownership === 'shared-refcount' ? '->' : '.'
    const causeText = `${payloadText}${access}${cppRecordFieldName('cause')}`
    const guards = [outerGuard, cause.required ? null : `${payloadText}${access}${cppRecordFieldPresenceName('cause')}`].filter(
      (guard): guard is string => guard !== null
    )
    lines.push(`${guards.length > 0 ? `if (${guards.join(' && ')}) ` : ''}${base}.setCause(${causeText});`)
  }
  return lines
}
