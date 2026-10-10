import { carriesNativeUndefined, type Representation } from '../representation/model.js'

export const NATIVE_REFERENCE_ABSENCE = 'gea::native-reference::absence'

/** Strict native receivers preserve undefined separately from the reference's null lane. */
export const nativeReferenceAbsenceOf = (source: Representation, target: Representation): 'undefined' | 'null' | null =>
  (source.kind === 'undefined' || source.kind === 'null') && carriesNativeUndefined(target) ? source.kind : null
