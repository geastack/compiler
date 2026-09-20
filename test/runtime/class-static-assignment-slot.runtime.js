// @ts-nocheck
//! expect: 16711680 255 undefined
//! expect: 3 red green blue
//! expect: 65280 swatch

// The dominant static-field idiom in ordinary JavaScript: a table assigned
// onto the constructor from module scope rather than written as a `static`
// member of the class body.
//
// The class layout records only what the BODY declares, so this slot is absent
// from it -- and reading that silence as "this key names no slot" used to
// promote the assigned TABLE to a full dynamic field protocol, one boxed reader
// and one boxed descriptor for every colour in it, while the target was already
// storing it in a typed global. The whole-program static-field census is what
// actually knows the slot's carrier, and it is now what the reflection census
// asks.
//
// What must not change is the answer. The table is a live own property of the
// constructor: readable by name, readable by computed key, enumerable, and
// writable through the same slot afterwards.

class Swatch {
  constructor(name) {
    this.name = name
  }
  value() {
    return Swatch.NAMES[this.name]
  }
}

Swatch.NAMES = { red: 0xff0000, green: 0x00ff00, blue: 0x0000ff }

console.log(new Swatch('red').value(), new Swatch('blue').value(), new Swatch('teal').value())

const keys = Object.keys(Swatch.NAMES)
console.log(keys.length, keys[0], keys[1], keys[2])

// A second slot on the same constructor, holding a different carrier, is
// storage of its own rather than a second opinion about the first.
Swatch.LABEL = 'swatch'
console.log(new Swatch('green').value(), Swatch.LABEL)
