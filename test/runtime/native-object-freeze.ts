// `Object.freeze` over a native record, and what a rejected write DOES.
//
// Every write below throws rather than being silently dropped, and that is not
// a choice this fixture makes: the suite compiles with `module: ESNext`, so
// every program is an ES module, and an ES module is strict in its entirety
// (ECMA-262 11.2.2). A store to a non-writable property throws `TypeError` in
// strict code. Verified against real `node` on this file's own emitted module,
// which prints `false` and then throws at `bag.count = 2`.
//
// The earlier version of this fixture performed the three writes bare and
// asserted the frozen values afterwards -- which only holds in sloppy mode, a
// mode this suite cannot produce. The probes catch instead, so the program
// exercises the same rejection and still runs to completion.
type Bag = { count: number; label?: string }

const bag: Bag = { count: 1, label: 'ready' }
const alias = bag

console.log(Object.isFrozen(bag))
//! expect: false
const returned = Object.freeze(bag)

const rejects = (write: () => void): string => {
  try {
    write()
    return 'missing'
  } catch (error) {
    return (error as Error).name
  }
}

console.log(
  rejects(() => {
    bag.count = 2
  }),
  rejects(() => {
    bag.label = 'changed'
  }),
  rejects(() => {
    ;(bag as any).extra = 3
  })
)
//! expect: TypeError TypeError TypeError

console.log(Object.isFrozen(alias), returned.count, alias.count, alias.label, Object.keys(alias).join(','))
//! expect: true 1 1 ready count,label
