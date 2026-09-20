//! expect: [1 2 4]

// `Object.create(null)` has no type of its own worth having -- it is `any` --
// so every use below is really a test of whether the CONTEXT supplies the type:
// a field's declared type, an index signature's value type, a parameter.
//
// The fixture used to state no expectation at all (no `//!` line), which made
// it a compile-and-run check wearing the clothes of a behaviour test: it could
// have printed anything. It also did not typecheck under its own project. Both
// are fixed here; neither changes what it is trying to exercise.
//
// The type errors were six `Object is possibly 'undefined'` (TS2532), and they
// are correct: `test/runtime/tsconfig.json` sets `noUncheckedIndexedAccess`,
// under which reading `t[k]` off a `Record<string, V>` yields `V | undefined`
// -- the whole point of the flag being that a key's presence is not implied by
// the index signature. A standalone `tsc` still emits for such a program
// (`noEmitOnError` defaults off), which is why this went unnoticed; this
// compiler holds a program to the diagnostics the checker reports for it.
//
// The TABLE assertions are `!`, not `?.`: each of those keys IS present, put
// there by the line above or by `install`, and `?.` would silently paper over
// a genuinely missing table. `!` states the claim the program is making.
//
// `total()` reads the counts with `?? 0` rather than `count!`, and that is NOT
// a stylistic choice -- it dodges a real compiler gap, recorded here so it is
// not mistaken for one:
//
//   `return this.tables.ALL!.count! + this.tables.POST!.count!`
//   -> emission refuses "runtime-helper:computation:binary:+:optional":
//      binary "+" on an "optional" carrier has no C++ spelling.
//
// The checker types `count!` as `number`. The representation layer keeps the
// optional carrier anyway, because a non-null assertion is ERASED rather than
// treated as the narrowing it is -- so the two authorities disagree about a
// cell the checker already settled. `?? 0` reaches the same value through a
// construct that does produce a bare carrier, which is why the A/B is clean:
// same program, same output, one spelling emits and the other refuses.
//
// Not fixed here because the narrowing lives in the binding/structural census,
// which another session has open. This fixture is about `Object.create(null)`
// contextual typing and should test that rather than be blocked on an
// unrelated gap; the gap is written down instead of being quietly absorbed.
//
// (`fill` still uses `count!` and emits fine -- the preceding `table.count = 4`
// narrows it by flow, so no optional carrier ever reaches the read.)

type NumberTable = Record<string, number>
type NestedTable = Record<string, NumberTable>

class Registry {
  private tables: NestedTable

  constructor() {
    this.tables = { ALL: Object.create(null) }
    this.tables.ALL!.count = 0
  }

  install(name: string): void {
    this.tables[name] = Object.create(null)
    this.tables[name]!.count = 2
  }

  total(): number {
    return (this.tables.ALL!.count ?? 0) + (this.tables.POST!.count ?? 0)
  }
}

const globalTable: NumberTable = Object.create(null)
globalTable.count = 1

function fill(table: NumberTable): number {
  table.count = 4
  return table.count!
}

const registry = new Registry()
registry.install('POST')
// Bracketed because `//! expect:` is a substring test.
console.log(`[${globalTable.count} ${registry.total()} ${fill(Object.create(null))}]`)
