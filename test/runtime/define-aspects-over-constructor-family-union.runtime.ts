// A database client's `defineAspects`: `Object.defineProperty(operation, 'aspects', ...)`
// where `operation: { aspects?: Set<symbol> }` receives several operation
// class constructors and a plain object. The parameter is a union of a record
// and one constructor family per class, and the define lands on whichever arm
// is live: a constructor's own static property, read back through
// `this.constructor`, or the record's own field.
const READ = Symbol('READ')
const RETRY = Symbol('RETRY')

abstract class AbstractOperation {
  static aspects?: Set<symbol>
  hasAspect(aspect: symbol): boolean {
    const ctor = this.constructor as { aspects?: Set<symbol> }
    if (ctor.aspects == null) return false
    return ctor.aspects.has(aspect)
  }
}

class AggregateOperation extends AbstractOperation {
  constructor(readonly pipeline: string[]) {
    super()
  }
}
class CountOperation extends AggregateOperation {}
class PingOperation extends AbstractOperation {
  constructor(readonly comment: string) {
    super()
  }
}
class DropOperation extends AbstractOperation {}

function defineAspects(operation: { aspects?: Set<symbol> }, aspects: symbol | symbol[] | Set<symbol>): Set<symbol> {
  if (!Array.isArray(aspects) && !(aspects instanceof Set)) {
    aspects = [aspects]
  }
  aspects = new Set(aspects)
  Object.defineProperty(operation, 'aspects', {
    value: aspects,
    writable: false
  })
  return aspects
}

defineAspects(AggregateOperation, [READ, RETRY])
defineAspects(PingOperation, READ)
const plain: { aspects?: Set<symbol> } = {}
defineAspects(plain, new Set([RETRY]))

const report = (operation: AbstractOperation): string => `${operation.hasAspect(READ)}/${operation.hasAspect(RETRY)}`
//! expect: true/true true/true true/false false/false
console.log(
  report(new AggregateOperation(['$match'])),
  report(new CountOperation([])),
  report(new PingOperation('hi')),
  report(new DropOperation())
)
//! expect: 2 1 true 1 true
console.log(
  CountOperation.aspects?.size,
  PingOperation.aspects?.size,
  DropOperation.aspects === undefined,
  plain.aspects?.size,
  plain.aspects?.has(RETRY)
)
