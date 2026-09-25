// @ts-nocheck
//! expect: installed 4000 true
//! expect: read 100000 7999
//! expect: fast true
// TSL puts ~3,400 entries on one prototype. Installing 4,000 and reading
// 10^5 of them has to stay a hash lookup per read, not a scan of the table.
class ManyNode {
  constructor(v) {
    this.v = v
  }
}
const started = Date.now()
for (let i = 0; i < 4000; i++) {
  ManyNode.prototype['m' + i] = function () {
    return this.v + i
  }
}
const node = new ManyNode(4000)
console.log('installed', 4000, typeof node.m3999 === 'function')
let last = 0
let reads = 0
for (let r = 0; r < 100000; r++) {
  last = node['m' + (r % 4000)]()
  reads++
}
console.log('read', reads, last)
console.log('fast', Date.now() - started < 5000)
