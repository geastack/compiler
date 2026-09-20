//! expect: point=3/4
//! emitted-has: switch (gea_json_which)
//! emitted-once: gea_json_read(reader, out.zeta)
// A record's JSON reader matches a key two ways -- byte-for-byte where it
// stands, then decoded -- but reads each field's value in ONE place: both
// matches produce an index into a single switch (`emit-json.ts`).
interface Point {
  xeta: number
  zeta: number
}
const point = JSON.parse('{"xeta":3,"zeta":4}') as Point
console.log(`point=${point.xeta}/${point.zeta}`)
