// An abstract method whose overrides each return their OWN class -- declared
// `this` (a database client's bulk-operation builder's `addToOperationsList`)
// or the root type narrowed per override (`TimeoutContext.refreshed():
// TimeoutContext`, with `override refreshed(): OperationTimeoutContext`). The slot's result is the join
// of the siblings, so a base-typed call reaches each override.
abstract class Bulk {
  readonly ops: string[] = []
  abstract add(op: string): this
  run(op: string): Bulk {
    return this.add(op)
  }
}
class Ordered extends Bulk {
  add(op: string): this {
    this.ops.push(`ordered:${op}`)
    return this
  }
}
class Unordered extends Bulk {
  add(op: string): this {
    this.ops.push(`unordered:${op}`)
    return this
  }
}

abstract class Context {
  abstract refreshed(): Context
  abstract get label(): string
}
class Csot extends Context {
  constructor(readonly generation: number) {
    super()
  }
  override refreshed(): Csot {
    return new Csot(this.generation + 1)
  }
  get label(): string {
    return `csot#${this.generation}`
  }
}
class Legacy extends Context {
  override refreshed(): Legacy {
    return this
  }
  get label(): string {
    return 'legacy'
  }
}

const bulks: Bulk[] = [new Ordered(), new Unordered()]
for (const bulk of bulks) console.log(bulk.run('insert').run('update').ops.join(','))
const contexts: Context[] = [new Csot(1), new Legacy()]
for (const context of contexts) console.log(context.refreshed().refreshed().label)

//! expect: ordered:insert,ordered:update
//! expect: unordered:insert,unordered:update
//! expect: csot#3
//! expect: legacy
