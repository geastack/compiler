//! oracle: node
interface Result {
  ok: boolean
  value: number
  rest: string
}
function digit(input: string): Result {
  if (input.length === 0) return { ok: false, value: 0, rest: input }
  const ch = input[0]
  const code = ch.charCodeAt(0)
  if (code >= 48 && code <= 57) return { ok: true, value: code - 48, rest: input.slice(1) }
  return { ok: false, value: 0, rest: input }
}
function number(input: string): Result {
  let value = 0
  let rest = input
  let read = 0
  while (true) {
    const r = digit(rest)
    if (!r.ok) break
    value = value * 10 + r.value
    rest = r.rest
    read += 1
  }
  return { ok: read > 0, value, rest }
}
export function main(): string {
  const text = '12,345,678'
  const out: number[] = []
  let rest = text
  while (rest.length > 0) {
    const r = number(rest)
    if (!r.ok) break
    out.push(r.value)
    rest = r.rest.startsWith(',') ? r.rest.slice(1) : r.rest
  }
  return 'parsed=' + out.join('|') + ' rest=' + rest
}
console.log(main())
