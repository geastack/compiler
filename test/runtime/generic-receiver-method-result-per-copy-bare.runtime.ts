// The minimal form of a database client's `executeOperation`/`tryOperation` result
// path: a generic function over `T extends AbstractOperation` (the base's own
// `TResult` defaults to `any`) returns `op.handleOk(r)`, declared as
// `ReturnType<T['handleOk']>`. Each copy of `f`/`g` is instantiated at one
// concrete operation, so its result is that class's `handleOk` result --
// never the base's unfilled `TResult` and never `void`, which would prove the
// non-void copies' `return` unreachable and throw at run time.
type Doc = { [key: string]: any }
type InsertResult = { acknowledged: boolean; insertedId: number }
type DeleteResult = { acknowledged: boolean; deletedCount: number }
abstract class AbstractOperation<TResult = any> {
  abstract handleOk(response: Doc): TResult
}
class RunCommand extends AbstractOperation<void> {
  handleOk(): void {}
}
class Count extends AbstractOperation<number> {
  handleOk(r: Doc): number {
    return r.n
  }
}
class Update extends AbstractOperation<Doc> {
  handleOk(r: Doc): Doc {
    return { modified: r.n }
  }
}
class Insert extends AbstractOperation<InsertResult> {
  handleOk(r: Doc): InsertResult {
    return { acknowledged: true, insertedId: r.n }
  }
}
class DeleteOne extends AbstractOperation<DeleteResult> {
  handleOk(r: Doc): DeleteResult {
    return { acknowledged: true, deletedCount: r.n }
  }
}
const r: Doc = { n: 2 }
async function f<T extends AbstractOperation>(op: T): Promise<ReturnType<T['handleOk']>> {
  return op.handleOk(r)
}
function g<T extends AbstractOperation>(op: T): ReturnType<T['handleOk']> {
  return op.handleOk(r)
}
async function main() {
  //! expect: undefined
  console.log(await f(new RunCommand()))
  //! expect: undefined
  console.log(g(new RunCommand()))
  //! expect: 2 {"modified":2} {"acknowledged":true,"insertedId":2} {"acknowledged":true,"deletedCount":2} undefined
  console.log(
    await f(new Count()),
    JSON.stringify(await f(new Update())),
    JSON.stringify(await f(new Insert())),
    JSON.stringify(await f(new DeleteOne())),
    await f(new RunCommand())
  )
  //! expect: 2 {"modified":2} {"acknowledged":true,"insertedId":2} {"acknowledged":true,"deletedCount":2} undefined
  console.log(
    g(new Count()),
    JSON.stringify(g(new Update())),
    JSON.stringify(g(new Insert())),
    JSON.stringify(g(new DeleteOne())),
    g(new RunCommand())
  )
}
main()
