// A method inherited from a generic base whose type parameter defaults to
// `any`, called on a receiver typed by that default: a database client's
// `executeOperation<T extends AbstractOperation>(op: T)` calls
// `op.hasAspect(...)`, and every operation class reaches `AbstractOperation`
// through a DIFFERENT filling (`CommandOperation<Document>`,
// `CommandOperation<number>`, ...). The same shape is `this.hasAspect(...)`
// inside the generic middle class. Each receiver is an instance of its own
// copy of the base, and the call must reach it as one.
//
// They reach it because the base's copies do NOT split: nothing it stores
// mentions `TResult`. `options` is typed through an object LITERAL alias, which
// layout relevance once read as "may mention every parameter" -- one layout
// per result type, and every receiver refused at the `any` copy.
type Abortable = { signal?: string }
abstract class AbstractOp<TResult = any> {
  options: Abortable = {}
  constructor(readonly aspects: number) {}
  hasAspect(aspect: number): boolean {
    return (this.aspects & aspect) !== 0
  }
  abstract run(): TResult
  handleOk(response: { value: unknown }): TResult {
    return response.value as TResult
  }
}

abstract class CommandOp<T> extends AbstractOp<T> {
  get retryable(): boolean {
    return this.hasAspect(2)
  }
}

class ListOp extends CommandOp<string[]> {
  run(): string[] {
    return ['a', 'b']
  }
}

class CountOp extends CommandOp<number> {
  run(): number {
    return 7
  }
  override handleOk(response: { value: unknown }): number {
    return (response.value as number) * 2
  }
}

class RawOp extends AbstractOp {
  run() {
    return 5
  }
}

function exec<T extends AbstractOp>(op: T): string {
  return `${op.hasAspect(1)} ${op.hasAspect(2)} ${op.handleOk({ value: op.run() })}`
}

const list = new ListOp(1)
const count = new CountOp(3)
console.log(exec(list), exec(count), exec(new RawOp(0)))
console.log(list.retryable, count.retryable, list.run().length, count.run())
//! expect: true false a,b true true 14 false false 5
//! expect: false true 2 7
