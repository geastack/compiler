import ts from '#typescript'

/**
 * `#ts-internals`: what the compiler reads from TypeScript beyond its public
 * declarations. TypeScript exports these at runtime without declaring them, so
 * the JavaScript compiler reaches them through a narrow cast.
 */
const internals = ts as unknown as {
  readonly FlowFlags: Readonly<
    Record<'Unreachable' | 'Start' | 'Label' | 'Assignment' | 'TrueCondition' | 'Condition' | 'SwitchClause', number>
  >
  readonly signatureHasRestParameter?: (signature: ts.Signature) => boolean
}

export const FlowFlags = internals.FlowFlags
export const signatureHasRestParameter = internals.signatureHasRestParameter
