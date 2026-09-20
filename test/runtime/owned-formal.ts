class Message {
  text: string
  constructor(text: string = 'default message') {
    this.text = text
  }
}
function relay(text: string): Message {
  return new Message(text)
}
function take(text: string = 'default'): string {
  return text
}
function revisit(text: string | undefined): string {
  if (text === undefined) return 'absent'
  const first = take(text)
  return first + ':' + text
}
function repeat(text: string | undefined): string {
  let result = ''
  for (let i = 0; i < 3; i++) {
    if (text !== undefined) result += take(text)
  }
  return result
}
function sameBlock(text: string | undefined): string {
  if (text === undefined) return 'absent'
  return text.length + ':' + take(text) + ':' + text
}
const input = 'a sufficiently long message with an independently owned string buffer'
console.log(relay(input).text === input)
console.log(input)
console.log(new Message().text)
console.log(revisit(input))
console.log(repeat(input))
console.log(sameBlock(input))
console.log(take(undefined))
