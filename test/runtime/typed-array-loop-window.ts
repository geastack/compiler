//! expect: 0 97 98 233 61 0
//! expect: 98 233 61 0
//! expect: 0 0 0
//! expect: 0 97
//! emitted-has: gea::denseIndexWindow
//! emitted-has: uint8_t* gea_dense_

function write(output: Uint8Array, text: string, offset: number): void {
  for (let i = 0, cursor = offset; i < text.length; i++, cursor++) {
    output[cursor] = text.charCodeAt(i)
  }
}
const normal = new Uint8Array(6)
write(normal, 'abé😀', 1)
console.log(normal[0], normal[1], normal[2], normal[3], normal[4], normal[5])
const negative = new Uint8Array(4)
write(negative, 'abé😀', -1)
console.log(negative[0], negative[1], negative[2], negative[3])
const invalid = new Uint8Array(3)
write(invalid, 'abc', 0.5)
write(invalid, 'abc', NaN)
write(invalid, 'abc', Infinity)
write(invalid, '', 0)
console.log(invalid[0], invalid[1], invalid[2])
const short = new Uint8Array(2)
write(short, 'abc', 1)
console.log(short[0], short[1])
