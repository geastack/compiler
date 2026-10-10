// A database client tags each operation CLASS with its aspects:
// `defineAspects(AggregateOperation, [Aspect.READ_OPERATION, ...])` passes the
// class itself as `{ aspects?: Set<symbol> }` and `Object.defineProperty`s
// `aspects` onto it; `hasAspect` reads it back through
// `this.constructor as { aspects?: Set<symbol> }`. The property lives on the
// constructor object, so a subclass without its own `aspects` inherits its
// base's through the constructor's prototype chain, and a class never tagged
// answers `undefined`. `AbstractOperation` declares `static aspects?` for the
// checker only: without an initializer it defines nothing.
const READ = Symbol('READ')
const RETRY = Symbol('RETRY')

function defineAspects(operation: { aspects?: Set<symbol> }, aspects: symbol | symbol[]): Set<symbol> {
  const set = new Set(Array.isArray(aspects) ? aspects : [aspects])
  Object.defineProperty(operation, 'aspects', { value: set, writable: false })
  return set
}

abstract class AbstractOperation {
  static aspects?: Set<symbol>
  hasAspect(aspect: symbol): boolean {
    const ctor = this.constructor as { aspects?: Set<symbol> }
    if (ctor.aspects == null) return false
    return ctor.aspects.has(aspect)
  }
}

class AggregateOperation extends AbstractOperation {}
class CountOperation extends AggregateOperation {}
class PingOperation extends AbstractOperation {}
class DropOperation extends AbstractOperation {}

defineAspects(AggregateOperation, [READ, RETRY])
defineAspects(PingOperation, READ)

const report = (operation: AbstractOperation): string => `${operation.hasAspect(READ)}/${operation.hasAspect(RETRY)}`
console.log(report(new AggregateOperation()), report(new CountOperation()), report(new PingOperation()), report(new DropOperation()))
//! expect: true/true true/true true/false false/false
