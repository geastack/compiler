//! expect: 8 2 3 7

function reassigned(text: string): number {
  const first = text.length
  text = 'changed'
  return first + text.length
}
function capturedLength(text: string): number {
  const change = (): void => {
    text = 'xy'
  }
  const first = text.length
  change()
  return first * 10 + text.length
}
function branched(text: string, branch: boolean): number {
  if (branch) return text.length
  return text.length + 4
}
console.log(reassigned('a'), capturedLength(''), branched('abc', true), branched('abc', false))
