import type { Representation } from './model.js'

/**
 * The only argument carriers the Function constructor can transport without
 * turning a native value into the dynamic evaluator carrier. A string is
 * already its own ToString result; a dynamic value is already owned by the
 * evaluator boundary and must retain its runtime coercion behaviour.
 */
export type FunctionConstructorArgumentKind = 'native-string' | 'dynamic-value'

/**
 * This is a generic ECMAScript boundary, not a guessed callable ABI. The
 * returned Function remains dynamic because its source controls its frame.
 */
export const functionConstructorArgumentKindOf = (representation: Representation): FunctionConstructorArgumentKind | null => {
  if (representation.kind === 'string') return 'native-string'
  return representation.kind === 'dynamic' ? 'dynamic-value' : null
}
