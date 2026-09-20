class Item {
  text: string
  constructor(text: string = 'default') {
    this.text = text
  }
}
function constructItem(text: string): string {
  return new Item(text).text
}
function invoke(callback: (text: string) => string): string {
  return callback('first') + ':' + callback('second')
}
console.log(invoke((text: string) => constructItem(text)))
class Cold {
  value = 7
}
function once(): number {
  const cold = new Cold()
  let result = 0
  for (let i = 0; i < 3; ++i) result += cold.value
  return result
}
console.log(once())
let Selected = Cold
function change(): void {
  Selected = Cold
}
console.log(
  invoke((text: string) => {
    const result = new Selected().value
    change()
    return text + result
  })
)
