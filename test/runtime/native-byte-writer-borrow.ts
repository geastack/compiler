//! expect: 3 97 98 99 -1 97
//! emitted-has: const std::string& gea_arg_1

function writeAscii(output: Uint8Array, text: string, offset: number): number {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code > 127) return -1
    output[offset + i] = code
  }
  return text.length
}

const bytes = new Uint8Array(8)
const first = writeAscii(bytes, 'abc', 1)
const second = writeAscii(bytes, 'aé', 5)
console.log(first, bytes[1], bytes[2], bytes[3], second, bytes[5])
