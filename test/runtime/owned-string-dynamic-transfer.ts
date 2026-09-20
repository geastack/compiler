//! emitted-has: static_cast<std::string>(std::move(
//! expect: 96 97 194 291
//! expect: 97 97 97
//! expect: caught 97

function text(seed: string): string {
  return seed.repeat(96)
}

function deadResult(): unknown {
  let value: unknown = text('x')
  return value
}

function copiedAlias(): string {
  const native = text('y') + '!'
  const value: unknown = native
  if (typeof value !== 'string') throw new Error('wrong carrier')
  return native + value
}

function loopCarried(): string {
  const native = text('z') + '!'
  let output = ''
  for (let i = 0; i < 3; i++) {
    const value: unknown = native
    if (typeof value !== 'string') throw new Error('wrong carrier')
    output += value
  }
  return output
}

function loopProduced(): number {
  let size = 0
  for (let i = 0; i < 3; i++) {
    let value: unknown = text('w')
    if (typeof value !== 'string') throw new Error('wrong carrier')
    size += value.length
  }
  return size
}

const result = deadResult()
if (typeof result !== 'string') throw new Error('wrong carrier')
console.log(result.length, (text('q') + '!').length, copiedAlias().length, loopCarried().length)
const kept = text('a') + '!'
const container = { value: kept }
const changed: unknown = container.value
const fieldLength = container.value.length
container.value = 'replacement'
if (typeof changed !== 'string') throw new Error('wrong carrier')
console.log(kept.length, changed.length, fieldLength)

function throwing(): void {
  const native = text('b') + '!'
  try {
    const value: unknown = native
    if (typeof value === 'string') throw new Error('caught')
  } catch {
    console.log('caught', native.length)
  }
}
throwing()
if (loopProduced() !== 288) throw new Error('loop donation changed the value')
