//! expect: member=alpha:y
//! expect: detached throws
//! expect: bound=alpha:z
//! expect: call=other:q
//! expect: rebound=other:r
interface Probe {
  probe(value: string): string
}

class Alpha implements Probe {
  name: string
  constructor(name: string) {
    this.name = name
  }
  probe(value: string): string {
    return this.name + ':' + value
  }
}

class Beta implements Probe {
  name = 'beta'
  probe(value: string): string {
    return this.name + ':' + value
  }
}

function choose(index: number): Probe {
  return index === 0 ? new Alpha('alpha') : new Beta()
}

const chosen = choose(0)
console.log('member=' + chosen.probe('y'))
const extracted = chosen.probe
try {
  extracted('x')
  console.log('detached received the original object')
} catch {
  console.log('detached throws')
}
console.log('bound=' + chosen.probe.bind(chosen)('z'))
const other = new Alpha('other')
console.log('call=' + extracted.call(other, 'q'))
console.log('rebound=' + extracted.bind(other)('r'))
