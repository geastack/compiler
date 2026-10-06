//! expect: detached-type=undefined
//! expect: null-type=object
//! expect: detached-self=undefined
//! expect: detached-is-null=false
//! expect: null-self=null
//! expect: effect before read
//! expect: read throws
//! expect: other-read=other
//! expect: identity=true
interface ReceiverProbe {
  kind(): string
  self(): ReceiverProbe
  read(): string
}

class First implements ReceiverProbe {
  name: string
  constructor(name: string) {
    this.name = name
  }
  kind(): string {
    return typeof this
  }
  self(): ReceiverProbe {
    return this
  }
  read(): string {
    console.log('effect before read')
    return this.name
  }
}

class Second implements ReceiverProbe {
  name = 'second'
  kind(): string {
    return typeof this
  }
  self(): ReceiverProbe {
    return this
  }
  read(): string {
    return this.name
  }
}

function choose(index: number): ReceiverProbe {
  return index === 0 ? new First('first') : new Second()
}

const original = choose(0)
const kind = original.kind
const self = original.self
const read = original.read
console.log('detached-type=' + kind())
console.log('null-type=' + kind.call(null))
const returned = self()
console.log('detached-self=' + String(returned))
console.log('detached-is-null=' + (returned === null))
console.log('null-self=' + String(self.call(null)))
try {
  read()
  console.log('read unexpectedly succeeded')
} catch {
  console.log('read throws')
}
const other = new First('other')
console.log('other-read=' + read.call(other))
console.log('identity=' + (original.kind === choose(0).kind))
