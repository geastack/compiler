// ECMA-262 24.1.1.1 / 24.2.1.1: `new Map(iterable)` and `new Set(iterable)`
// drain the argument's own iterator. A database client's topology description copies its
// server table with `new Map(this.servers)` and takes the key set with
// `new Set(this.servers.keys())`.

class Server {
  readonly address: string
  constructor(address: string) {
    this.address = address
  }
}

const servers = new Map<string, Server>()
servers.set('b:1', new Server('b:1'))
servers.set('a:1', new Server('a:1'))

const copy = new Map(servers)
copy.set('c:1', new Server('c:1'))
//! expect: copy=b:1,a:1,c:1 source=2
console.log('copy=' + [...copy.keys()].join(',') + ' source=' + servers.size)
//! expect: same-instance=true
console.log('same-instance=' + (copy.get('a:1') === servers.get('a:1')))

const names = new Set(servers.keys())
names.add('b:1')
//! expect: names=b:1,a:1
console.log('names=' + [...names].join(','))

function* hosts(): Generator<string, void, void> {
  yield 'x'
  yield 'y'
  yield 'x'
}
//! expect: generated=2
console.log('generated=' + new Set(hosts()).size)
