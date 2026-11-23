// An options bag allocated at a wide shape whose `context` slot is declared
// at a base class, handed on as a narrower options type whose `context` is
// the descendant. A rest copy of the narrow bag reads every key through that
// view, so the slot's value enters the descendant's carrier: checked against
// the allocation's class chain, never trusted as an unguarded downcast.

export {}

class TimeoutContext {
  constructor(readonly timeoutMS: number) {}
}

class CursorTimeoutContext extends TimeoutContext {
  readonly owner = 'cursor'
}

interface OperationOptions {
  context?: TimeoutContext
  comment?: string
  timeoutMS?: number
}

interface FindOptions {
  context?: CursorTimeoutContext
  timeoutMS?: number
  limit?: number
}

function findOne(options: FindOptions = {}): string {
  const { ...opts } = options
  opts.limit = 1
  return `${opts.context === undefined ? 'none' : `${opts.context.owner}:${opts.context.timeoutMS}`} ${opts.timeoutMS ?? -1} ${opts.limit}`
}

const plain: OperationOptions = { comment: 'x', timeoutMS: 5 }
const carried: OperationOptions = { context: new CursorTimeoutContext(9) }
console.log(findOne(plain as FindOptions))
console.log(findOne(carried as FindOptions))
console.log(findOne({ context: new CursorTimeoutContext(2), timeoutMS: 4 }))
console.log(findOne())

//! expect: none 5 1
//! expect: cursor:9 -1 1
//! expect: cursor:2 4 1
//! expect: none -1 1
