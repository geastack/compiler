import { abiOfCallee } from '../projection/callee.js'
import { carriesNativeUndefined, type Representation } from '../representation/model.js'

const admitsNativeAbsence = (receiver: Representation): boolean =>
  carriesNativeUndefined(receiver) ||
  (receiver.kind === 'optional' && admitsNativeAbsence(receiver.payload)) ||
  (receiver.kind === 'tagged-union' && receiver.arms.some((arm) => admitsNativeAbsence(arm.value)))

const carriesCallable = (result: Representation): boolean =>
  abiOfCallee(result) !== null ||
  (result.kind === 'optional' && carriesCallable(result.payload)) ||
  (result.kind === 'tagged-union' && result.arms.some((arm) => carriesCallable(arm.value)))

/** A deferred native function read must still perform the property's nullish check before invocation arguments. */
export const nativePropertyReadNeedsCoercibility = (
  receiver: Representation,
  result: Representation,
  methodPresenceTest = false
): boolean => admitsNativeAbsence(receiver) && (methodPresenceTest || carriesCallable(result))
