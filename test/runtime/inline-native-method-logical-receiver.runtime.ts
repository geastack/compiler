//! expect: inline=base:other
//! expect: inline this=undefined
//! expect: inline absent throws
//! expect: detached throws
//! expect: override=child:child-other
//! expect: override absent throws
//! expect: selected=child:child-other
//! expect: base source=base:child-other
//! expect: identity=true
class ReceiverBase {
  name: string
  constructor(name: string) {
    this.name = name
  }
  read(): string {
    return 'base:' + this.name
  }
  kind(): string {
    return typeof this
  }
}

class ReceiverChild extends ReceiverBase {
  read(): string {
    return 'child:' + this.name
  }
}

function receiver(child: boolean, name: string): ReceiverBase {
  return child ? new ReceiverChild(name) : new ReceiverBase(name)
}

const plain = new ReceiverBase('original')
const other = new ReceiverBase('other')
console.log('inline=' + plain.read.call(other))
console.log('inline this=' + plain.kind.call(undefined))
try {
  plain.read.call(undefined)
} catch {
  console.log('inline absent throws')
}
const detached = plain.read
try {
  detached()
} catch {
  console.log('detached throws')
}
const source = receiver(true, 'source')
const childOther = new ReceiverChild('child-other')
console.log('override=' + source.read.call(childOther))
try {
  source.read.call(undefined)
} catch {
  console.log('override absent throws')
}
const selected = source.read
console.log('selected=' + selected.call(childOther))
const baseSource = receiver(false, 'base-source')
console.log('base source=' + baseSource.read.call(childOther))
console.log('identity=' + (selected === source.read))
