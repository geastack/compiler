interface PublicFields {
  shown: string
  extra?: string
}

const original = { shown: 'initial' }
const first: { shown: string } = original
const view = first as PublicFields
const chain = view as PublicFields & { other?: number }
console.log(`absent:${view.extra === undefined}:${chain.extra === undefined}`)
view.extra = 'first'
console.log(`chain:${chain.extra}`)
chain.extra = 'second'
console.log(`view:${view.extra}`)
chain.other = 42
const full = original as PublicFields & { other?: number }
console.log(`original:${full.extra}:${full.other}`)
original.shown = 'changed'
console.log(`shown:${view.shown}:${chain.shown}`)
console.log(`identity:${original === view}:${original === chain}`)
//! expect: absent:true:true
//! expect: chain:first
//! expect: view:second
//! expect: original:second:42
//! expect: shown:changed:changed
//! expect: identity:true:true
