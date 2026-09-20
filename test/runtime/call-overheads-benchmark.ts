//! expect: 501023500000
//! expect: 1500001500000
//! emitted-lacks: gea::arrayOf<double>
//! emitted-lacks: = gea::host::Math::max;
//! emitted-lacks: = gea::host::Math::min;

function makeTextClosure(text: string, offset: number): () => number {
  return () => text.length + offset
}

function makeLeafClosure(a: number, b: number, c: number): () => number {
  return () => a + b + c
}

function textWork(count: number): number {
  let checksum = 0
  const text = 'abcdefgh'.repeat(128)
  for (let i = 0; i < count; i++) checksum += makeTextClosure(text, i)()
  return checksum
}

function leafWork(count: number): number {
  let checksum = 0
  for (let i = 0; i < count; i++) checksum += makeLeafClosure(i, i + 1, i + 2)()
  return checksum
}

function mathWork(count: number): number {
  let checksum = 0
  let value = 12345
  for (let i = 0; i < count; i++) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0
    checksum += Math.min(Math.max(value / 4294967296, 0.25), 0.75)
  }
  return checksum
}

for (let sample = 0; sample < 7; sample++) {
  let start = Date.now()
  const text = textWork(1000000)
  console.log('text', sample, Date.now() - start, text)
  start = Date.now()
  const leaf = leafWork(1000000)
  console.log('leaf', sample, Date.now() - start, leaf)
  start = Date.now()
  const math = mathWork(3000000)
  console.log('math', sample, Date.now() - start, math)
}
