// A generic narrowed by `instanceof` to a class its own copy cannot be.
//
// `tryOperation<T extends AbstractOperation>(operation: T)` testing `operation
// instanceof AggregateOperation` is mongodb's `execute_operation.ts:198`, and
// monomorphization mints one copy per concrete `T`. In the copy where `T` is
// some OTHER operation class the narrowed type is `Find & Aggregate` -- two
// unrelated nominal classes, an intersection with no inhabitant -- and every
// read inside the branch derives a carrier for a value that cannot exist.
class Base {
  tag(): number {
    return 1
  }
}

class Left extends Base {
  override tag(): number {
    return 2
  }
}

class Right extends Base {
  override tag(): number {
    return 3
  }
  extra(): number {
    return 90
  }
}

const inspect = <T extends Base>(value: T): number => {
  if (value instanceof Right) return value.extra()
  return value.tag()
}

export const probe = inspect(new Left()) + inspect(new Right())

if (probe !== 92) throw new Error('uninhabited intersection branch computed the wrong result')
