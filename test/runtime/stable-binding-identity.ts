//! expect: 6 old new ab

function lengthOfStable(): number {
  const text = 'abcdef'
  return text.length
}

let shared = 'old'
function changeShared(): string {
  shared = 'new'
  return ''
}

function snapshot(): string {
  return shared + changeShared()
}

function localWrite(): string {
  let value = 'a'
  const previous = value
  value += 'b'
  return previous + value.slice(1)
}

console.log(lengthOfStable(), snapshot(), shared, localWrite())
