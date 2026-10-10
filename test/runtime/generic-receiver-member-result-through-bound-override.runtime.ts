// A generic body calling a member on a receiver whose type is its own type
// parameter (a database client's `tryOperation<T extends AbstractOperation>` calling
// `operation.handleOk(result)`). The checker resolves the member on the
// CONSTRAINT, `Operation<TResult = any>`, so the call's result is `any`; a copy
// that binds `T` to `CountOperation` calls `CountOperation.handleOk`, which
// returns a number, and must take that result natively rather than boxed.
//! expect: count:3 -> 6
//! expect: name:beta -> beta!
//! emitted-lacks: gea::Value::box

abstract class Operation<TResult = any> {
  abstract describe(): string
  abstract handleOk(payload: string): TResult
}

class CountOperation extends Operation<number> {
  constructor(readonly count: number) {
    super()
  }
  describe(): string {
    return `count:${this.count}`
  }
  handleOk(payload: string): number {
    return Number(payload) * 2
  }
}

class NameOperation extends Operation<string> {
  constructor(readonly name: string) {
    super()
  }
  describe(): string {
    return `name:${this.name}`
  }
  handleOk(payload: string): string {
    return `${payload}!`
  }
}

function run<T extends Operation>(operation: T): string {
  const label = operation.describe()
  return `${label} -> ${operation.handleOk(label.slice(label.indexOf(':') + 1))}`
}

console.log(run(new CountOperation(3)))
console.log(run(new NameOperation('beta')))
