// Reproduces `runtime-helper:computation:instanceof:dynamic:constructor-family`
// (mongodb CMAP-ping compass, 61 unmet rows / 28 distinct sites, all `catch`
// bindings or `unknown`/`any`-typed values tested against a program-defined
// `Error` subclass). TypeScript types an unannotated catch binding `unknown`
// (`useUnknownInCatchVariables`, the strict default) -- a genuine dynamic
// boundary, not a boxing defect -- and `MyError` is a program class, so the
// right-hand side resolves to `constructor-family`. The left is `dynamic`.

class MyError extends Error {
  code: number
  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

function mightThrow(flag: boolean): void {
  if (flag) throw new MyError('boom', 42)
  throw new Error('plain')
}

export function classify(flag: boolean): string {
  try {
    mightThrow(flag)
    return 'ok'
  } catch (error) {
    if (error instanceof MyError) {
      return `myerror:${error.code}`
    }
    return 'other'
  }
}

export const probe = classify(true)
