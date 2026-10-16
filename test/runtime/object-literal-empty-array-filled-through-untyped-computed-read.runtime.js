// A JavaScript class holding an object literal of empty arrays, filled later
// from an untyped bank index through `this.koto[k.layer]` -- a computed read
// the checker types `any` (`noImplicitAny` is off), so neither the checker nor
// the array census saw the push. The members stayed `never[]`, arrays that hold
// nothing: the push aborted on its first element, and the reads through
// `this.koto[l]` and `this.koto[layer]` would have turned every element into
// `undefined`.

export {}

class KotoLayers {
  constructor() {
    this.koto = { mf: [], f: [] }
  }
  init(index) {
    for (const k of index.koto) this.koto[k.layer].push(k)
    for (const l of ['mf', 'f']) this.koto[l].sort((a, b) => a.midi - b.midi)
  }
  pluck(midi) {
    const layer = midi > 60 ? 'f' : 'mf'
    const set = this.koto[layer]
    if (!set.length) return 'none'
    let best = set[0]
    for (const k of set) if (Math.abs(k.midi - midi) < Math.abs(best.midi - midi)) best = k
    return best.file
  }
  first(layer) {
    return this.koto[layer][0].file
  }
}

const layers = new KotoLayers()
//! expect: none none
console.log(layers.pluck(60) + ' ' + layers.pluck(61))
layers.init(
  JSON.parse('{"koto":[{"layer":"mf","midi":62,"file":"a"},{"layer":"f","midi":70,"file":"c"},{"layer":"f","midi":55,"file":"b"}]}')
)
//! expect: a c b first=b
console.log(layers.pluck(60) + ' ' + layers.pluck(69) + ' ' + layers.pluck(61) + ' first=' + layers.first('f'))
