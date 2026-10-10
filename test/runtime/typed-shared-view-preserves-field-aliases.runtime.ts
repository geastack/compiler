//! expect: original=through-view
//! expect: view=through-origin
//! expect: chain=through-origin
//! expect: original-after-chain=through-chain
//! expect: wider=through-chain
//! expect: original-number=42
//! expect: original-kind=number
//! expect: view-number=42
//! expect: view-kind=number
//! expect: chain-kind=number
//! expect: wider-after-original=restored

class FieldOrigin {
  shown = 'initial'
  also = 'middle'
  hidden = 'retained'
}

const original = new FieldOrigin()
const view: { shown: string; also: string } = original
const chain: { shown: string } = view
view.shown = 'through-view'
console.log('original=' + original.shown)
original.shown = 'through-origin'
console.log('view=' + view.shown)
console.log('chain=' + chain.shown)
chain.shown = 'through-chain'
console.log('original-after-chain=' + original.shown)

const wider: { shown: string | number } = original
console.log('wider=' + wider.shown)
wider.shown = 42
console.log('original-number=' + original.shown)
console.log('original-kind=' + typeof original.shown)
console.log('view-number=' + view.shown)
console.log('view-kind=' + typeof view.shown)
console.log('chain-kind=' + typeof chain.shown)
original.shown = 'restored'
console.log('wider-after-original=' + wider.shown)
