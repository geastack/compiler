// Helper for `reexported-generic-const-arrows.ts`: generic arrows held in
// `const` bindings, so their type parameters sit on the arrow rather than on
// the declaration the module exports.
export const runIfFn = <T>(
  v: T | undefined,
  ...a: T extends (...a: any[]) => void ? Parameters<T> : never
): T extends (...a: any[]) => void ? NonNullable<ReturnType<T>> : NonNullable<T> => {
  const res = typeof v === 'function' ? v(...a) : v
  return res ?? undefined
}

export const callAll =
  <T extends (...a: any[]) => void>(...fns: (T | null | undefined)[]) =>
  (...a: Parameters<T>) => {
    fns.forEach((fn) => {
      fn?.(...a)
    })
  }

export const first = <T>(v: T[]): T | undefined => v[0]

export const pair = <T>(a: T, b: T): T[] => [a, b]

export const twice = (n: number) => n * 2
