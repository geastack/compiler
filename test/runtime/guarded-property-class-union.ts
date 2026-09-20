//! expect: 7 9

class Wrapped {
  get kind(): 'wrapped' {
    return 'wrapped'
  }
  constructor(public value: number) {}
}
function readGuarded(low: { t: number | Wrapped }): number {
  if (typeof low.t !== 'number' && (typeof low.t !== 'object' || low.t.kind !== 'wrapped')) {
    throw new Error('bad value')
  }
  return typeof low.t === 'number' ? low.t : low.t.value
}
console.log(readGuarded({ t: 7 }), readGuarded({ t: new Wrapped(9) }))
