interface LegacyBinary {
  $type: string
  $binary: string
}

interface ModernBinary {
  $binary: string
}

let calls = 0
function encoded(): string {
  calls++
  return 'AP9/'
}

function binary(legacy: boolean): LegacyBinary | ModernBinary {
  if (legacy) return { $binary: encoded(), $type: '00' }
  return { $binary: encoded() }
}

function printBinary(value: LegacyBinary | ModernBinary): void {
  if ('$type' in value) {
    value.$type = '01'
    console.log(value.$type, value.$binary)
  } else {
    value.$binary = value.$binary + '!'
    console.log(value.$binary)
  }
}

printBinary(binary(true))
printBinary(binary(false))
console.log(calls)
