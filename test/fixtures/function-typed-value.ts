// The bare `Function` interface states callability and nothing else -- no
// parameter list, no arity, no result -- so there is no physical frame to
// choose for a value whose only stated type is it. Before
// `FunctionDeclarationPolicy` (representation/policies.ts) it derived to
// `native-handle(Function@1)`, a host protocol no target can ever register,
// and the whole program refused with an obligation nothing could satisfy.
//
// A program reaches the type without ever writing the name, which is what
// makes this worth a fixture: `typeof x === 'function'` NARROWS an `unknown`
// to `Function`, so a guard that should have left the value exactly as
// dynamic as it already was instead made it uncarriable. The narrowing must
// still answer, and it must answer correctly for both arms.
const isCallable = (value: unknown): number => (typeof value === 'function' ? 1 : 0)

const twice = (n: number): number => n * 2

export const probe = isCallable(twice) * 10 + isCallable(7) + twice(3)

if (probe !== 16) throw new Error('typeof-function narrowing carried the wrong thing')
