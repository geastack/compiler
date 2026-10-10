// A declared member the program reads AFTER every guard its declared type
// allows has failed -- narrowed to `never` -- and hands to a primitive
// parameter is stating what the member really holds. A database client declares
// `TopologyVersion.counter: Long`, reads it as
// `Long.isLong(c) ? c : Long.fromNumber(c)`, and its binary-document reader delivers
// the server's int64 as a `number`: the any-to-record assertion of the hello's
// `topologyVersion` refused that number.
class Wide {
  constructor(readonly value: number) {}
  static isWide(value: unknown): value is Wide {
    return value instanceof Wide
  }
  static fromNumber(value: number): Wide {
    return new Wide(value)
  }
  static fromBigInt(value: bigint): Wide {
    return new Wide(Number(value))
  }
}
interface Version {
  label: string
  counter: Wide
}
function normalize(version: Version): Wide {
  return Wide.isWide(version.counter) ? version.counter : Wide.fromNumber(version.counter)
}
function compare(left: Version, right: Version): number {
  const a =
    typeof left.counter === 'bigint'
      ? Wide.fromBigInt(left.counter)
      : Wide.isWide(left.counter)
        ? left.counter
        : Wide.fromNumber(left.counter)
  const b = normalize(right)
  return a.value - b.value
}
const wire: any = JSON.parse('{"label":"server","counter":7}')
const fromWire: Version | null = wire
const typed: Version = { label: 'typed', counter: new Wide(3) }
console.log(fromWire === null ? 'none' : `${fromWire.label} ${normalize(fromWire).value}`)
console.log(compare(fromWire!, typed), compare(typed, fromWire!))

//! expect: server 7
//! expect: 4 -4
