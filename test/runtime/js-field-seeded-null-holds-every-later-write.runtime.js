// A JavaScript class whose constructor seeds two fields with `null` and fills
// them later: `shaku` from an untyped bank index, `place` from a string or an
// untyped detour. The checker types both `any`, so the member carrier came from
// the census -- asked at the assignment `this.shaku = null`, whose value is that
// one write. Both fields were `std::nullptr_t`: `place`'s string store was
// refused at compile time, and `shaku`'s store aborted in its checked unbox
// (the field census had also joined `shaku`'s one speaking write, `null`, while
// the write that carries what it holds was silent).

export {}

class Flute {
  constructor() {
    this.shaku = null
    this.place = null
  }
  init(index) {
    this.shaku = index.shakuhachi
  }
  arrive(place, detour) {
    this.place = place
    if (detour) this.place = detour.name
  }
  breath() {
    return this.shaku ? this.shaku.file + ':' + this.shaku.midi : 'silent'
  }
  where() {
    return this.place === null ? 'nowhere' : this.place
  }
}

const flute = new Flute()
//! expect: silent nowhere
console.log(flute.breath() + ' ' + flute.where())
flute.init(JSON.parse('{"shakuhachi":{"file":"s","midi":67}}'))
flute.arrive('torii', null)
//! expect: s:67 torii
console.log(flute.breath() + ' ' + flute.where())
flute.arrive('lake', JSON.parse('{"name":"bridge"}'))
//! expect: bridge
console.log(flute.where())
