//! oracle-expect: v3|op42|seq513|delta-17|TS->CPP|footer16909060|sum8541|bytes20
interface Packet {
  version: number
  opcode: number
  sequence: number
  signedDelta: number
  payload: string
  checksum: number
}

function writeText(view: DataView, offset: number, text: string): number {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i))
  }
  return offset + text.length
}

function readText(view: DataView, offset: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(view.getUint8(offset + i))
  }
  return out
}

function checksum(view: DataView, length: number): number {
  let sum = 0
  for (let i = 0; i < length; i++) sum = (sum + view.getUint8(i) * (i + 1)) % 65536
  return sum
}

function encodePacket(): DataView {
  const buffer = new ArrayBuffer(24)
  const view = new DataView(buffer)
  const payload = 'TS->CPP'
  view.setUint8(0, 3)
  view.setUint8(1, 42)
  view.setUint16(2, 513, true)
  view.setInt16(4, -17, false)
  view.setUint8(6, payload.length)
  let end = writeText(view, 7, payload)
  view.setUint32(end, 0x01020304, false)
  end += 4
  view.setUint16(end, checksum(view, end), true)
  return new DataView(buffer, 0, end + 2)
}

function decodePacket(view: DataView): Packet {
  const payloadLength = view.getUint8(6)
  const footerOffset = 7 + payloadLength
  return {
    version: view.getUint8(0),
    opcode: view.getUint8(1),
    sequence: view.getUint16(2, true),
    signedDelta: view.getInt16(4, false),
    payload: readText(view, 7, payloadLength),
    checksum: view.getUint16(footerOffset + 4, true)
  }
}

export function main(): string {
  const view = encodePacket()
  const packet = decodePacket(view)
  const footer = view.getUint32(7 + packet.payload.length, false)
  return [
    'v' + packet.version,
    'op' + packet.opcode,
    'seq' + packet.sequence,
    'delta' + packet.signedDelta,
    packet.payload,
    'footer' + footer,
    'sum' + packet.checksum,
    'bytes' + view.byteLength
  ].join('|')
}

console.log(main())
