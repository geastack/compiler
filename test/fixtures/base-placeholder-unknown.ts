// Reproduces the framework `Component` base exactly: a placeholder method whose
// declared signature is `unknown`, overridden by every subclass with a concrete
// one, and called by nobody.
export class Base<RootElement = unknown> {
  readonly el: RootElement | null = null
  method(..._args: unknown[]): unknown {
    return null
  }
}

export class Derived extends Base {
  method(input: { n: number }): number {
    return input.n + 1
  }
}

export const answer = new Derived().method({ n: 1 })
