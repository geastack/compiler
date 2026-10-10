import type { NativeFieldViewPlan } from '../../conversion/native-field-view.js'
import type { Representation } from '../../representation/model.js'
import { cppRecordStructName, cppStringLiteral, cppTypeOf } from './types.js'
import { nativeFieldPolicyType } from './records.js'

export interface LiveFieldViewAccess {
  readonly key: string
  readonly read: { readonly value: Representation; readonly text: string } | null
  /**
   * The same read in the view's own declared field carrier, through the
   * plan's certified leaf. A reader that holds only the view's carrier -- an
   * internal Get no receipt names, like an iterator step's `done`/`value` --
   * asks for this one; a receipt still asks for the route's own.
   */
  readonly declared?: { readonly value: Representation; readonly text: string }
  readonly descriptorForward?: true
  readonly write: { readonly value: Representation; readonly statement: string } | null
}

/** Callbacks retain an immediate native source; no accessor runs while the view is allocated. */
export const liveFieldViewText = (plan: NativeFieldViewPlan, text: string, accesses: readonly LiveFieldViewAccess[]): string => {
  const readArms = accesses.map((access) => {
    if (access.descriptorForward)
      return `if (gea_key.text() == ${cppStringLiteral(access.key)}) return gea::nativeObjectDataReadNative(gea_live_source, gea_key, gea_read);`
    if (access.read === null) throw new Error('a native live field route has no read protocol')
    const type = cppTypeOf(access.read.value)
    const policy = nativeFieldPolicyType(access.read.value)
    const declared =
      access.declared === undefined
        ? ''
        : `if (gea_read.accepts<${cppTypeOf(access.declared.value)}, ${nativeFieldPolicyType(access.declared.value)}>()) ` +
          `return gea_read.assign<${nativeFieldPolicyType(access.declared.value)}>(${access.declared.text}); `
    return (
      `if (gea_key.text() == ${cppStringLiteral(access.key)}) { ` +
      `if (!gea_read.accepts<${type}, ${policy}>()) ${declared === '' ? 'return false;' : `{ ${declared}return false; }`} ` +
      `return gea_read.assign<${policy}>(${access.read.text}); }`
    )
  })
  const writeArms = accesses.map((access) => {
    if (access.write === null) return `if (gea_key.text() == ${cppStringLiteral(access.key)}) return false;`
    const type = cppTypeOf(access.write.value)
    const policy = nativeFieldPolicyType(access.write.value)
    return (
      `if (gea_key.text() == ${cppStringLiteral(access.key)}) { ` +
      `std::optional<${type}> gea_value; if (!gea_write.read<${policy}>(gea_value)) return false; ${access.write.statement} }`
    )
  })
  const sourceType = cppTypeOf(plan.source)
  const source = `const auto gea_live_source = gea_immediate.staticCast<typename ${sourceType}::element_type>();`
  const nativeExtensions = plan.source.kind === 'record' || (plan.source.kind === 'native-record-ref' && plan.source.native === null)
  const ordinaryRead = `return gea::nativeLiveViewSourceRead<${nativeExtensions}>(gea_live_source, gea_key, gea_read);`
  const ordinaryWrite = 'return gea::nativeLiveViewSourceWrite(gea_live_source, gea_key, gea_write);'
  const read =
    '+[](const gea::Ref<void>& gea_immediate, const gea::PropertyKey& gea_key, const gea::NativeFieldRead& gea_read) -> bool { ' +
    'if (gea::record::hasLiveFieldView(gea_immediate)) return gea::record::readFieldView(gea_immediate, gea_key, gea_read); ' +
    `${source} if (gea_key.isSymbol()) return false; ${readArms.join(' ')} ${ordinaryRead} }`
  const write =
    '+[](const gea::Ref<void>& gea_immediate, const gea::PropertyKey& gea_key, const gea::NativeFieldWrite& gea_write) -> bool { ' +
    'if (gea::record::hasLiveFieldView(gea_immediate)) return gea::record::writeFieldView(gea_immediate, gea_key, gea_write); ' +
    `${source} if (gea_key.isSymbol()) return false; ${writeArms.join(' ')} ${ordinaryWrite} }`
  const define =
    '+[](const gea::Ref<void>& gea_immediate, const gea::PropertyKey& gea_key, const gea::PropertyDescriptor& gea_descriptor) -> bool { ' +
    'if (gea::record::hasLiveFieldView(gea_immediate)) return gea::record::defineFieldView(gea_immediate, gea_key, gea_descriptor); ' +
    `${source} return gea::nativeDynamicDefineProperty(gea_live_source, gea_key, gea_descriptor); }`
  const hasOwn =
    '+[](const gea::Ref<void>& gea_immediate, const gea::PropertyKey& gea_key) -> bool { ' +
    'if (gea::record::hasLiveFieldView(gea_immediate)) return gea::record::hasOwnFieldView(gea_immediate, gea_key); ' +
    `${source} return gea::nativeDynamicHas(gea_live_source, gea_key); }`
  const hasProperty =
    '+[](const gea::Ref<void>& gea_immediate, const gea::PropertyKey& gea_key) -> bool { ' +
    'if (gea::record::hasLiveFieldView(gea_immediate)) return gea::record::hasPropertyFieldView(gea_immediate, gea_key); ' +
    `${source} return gea::nativeDynamicHasProperty(gea_live_source, gea_key); }`
  return (
    `gea::record::makeLiveViewWithOrigin<${cppRecordStructName(plan.target.shapeId)}>` +
    `(${text}, ${read}, ${write}, ${define}, ${hasOwn}, ${hasProperty})`
  )
}
