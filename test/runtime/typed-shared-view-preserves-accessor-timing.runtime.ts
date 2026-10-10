//! expect: allocated=0:0
//! expect: getter-original=true
//! expect: first=initial
//! expect: counts-after-read=1:0
//! expect: setter-original=true
//! expect: original-after-write=changed
//! expect: counts-after-write=1:1
//! expect: getter-original=true
//! expect: chain=changed
//! expect: counts-after-chain=2:1

let gets = 0
let sets = 0

class AccessorOrigin {
  stored = 'initial'
  hidden = 'retained'

  get shown(): string {
    gets++
    console.log('getter-original=' + (this === original))
    return this.stored
  }

  set shown(value: string) {
    sets++
    console.log('setter-original=' + (this === original))
    this.stored = value
  }
}

const original = new AccessorOrigin()
const view: { shown: string; stored: string } = original
const chain: { shown: string } = view
console.log('allocated=' + gets + ':' + sets)
console.log('first=' + view.shown)
console.log('counts-after-read=' + gets + ':' + sets)
view.shown = 'changed'
console.log('original-after-write=' + original.stored)
console.log('counts-after-write=' + gets + ':' + sets)
console.log('chain=' + chain.shown)
console.log('counts-after-chain=' + gets + ':' + sets)
