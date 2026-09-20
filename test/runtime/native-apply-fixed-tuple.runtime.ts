//! expect: homogeneous 7 11
//! expect: heterogeneous item:6
//! expect: rest 15
//! expect: grown-rest 22
//! expect: empty 7 -1
//! expect: once 9 1
//! expect: receiver 19
//! emitted-lacks: gea_cpp_value
//! emitted-lacks: gea::Value::box

function sum(a: number, b: number): number {
  return a + b
}
const pair: [number, number] = [3, 4]
const first = sum.apply(null, pair)
pair[0] = 7
console.log('homogeneous', first, sum.apply(null, pair))
function label(name: string, value: number): string {
  return name + ':' + value
}
const mixed: [string, number] = ['item', 6]
console.log('heterogeneous', label.apply(null, mixed))
function total(head: number, ...tail: number[]): number {
  let result = head
  for (const value of tail) result += value
  return result
}
const triple: [number, number, number] = [4, 5, 6]
console.log('rest', total.apply(null, triple))
triple.push(7)
console.log('grown-rest', total.apply(null, triple))
function constant(): number {
  return 7
}
function optional(value?: number): number {
  return value === undefined ? -1 : value
}
const empty: [] = []
console.log('empty', constant.apply(null, empty), optional.apply(null, empty))
let evaluations = 0
function argumentsOnce(): [number, number] {
  evaluations++
  return [4, 5]
}
console.log('once', sum.apply(null, argumentsOnce()), evaluations)
class Receiver {
  bias = 10
}
function withReceiver(this: Receiver, a: number, b: number): number {
  return this.bias + a + b
}
const receiverArgs: [number, number] = [4, 5]
console.log('receiver', withReceiver.apply(new Receiver(), receiverArgs))
