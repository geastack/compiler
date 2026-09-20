// The same base-class placeholder as `base-placeholder-unknown.ts`, declared
// without `unknown`. Both admit exactly the same set of subclass overrides --
// TypeScript's method bivariance is what makes `(...never[]) => void` as
// permissive a base as `(...unknown[]) => unknown` -- so the pair measures what
// the *declaration* costs, with the program held fixed.
export class Base<RootElement = never> {
  readonly el: RootElement | null = null
  method(..._args: never[]): void {}
}

export class Derived extends Base {
  method(input: { n: number }): number {
    return input.n + 1
  }
}

export const answer = new Derived().method({ n: 1 })
