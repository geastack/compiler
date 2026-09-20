//! expect: 3 97 98 99
//! emitted-has: const std::string& gea_arg_1
//! emitted-lacks: std::string gea_arg_1, double gea_arg_2) {\n
//! emitted-lacks: gea::collectCyclesIfNeeded();

function leaf(output: Uint8Array, text: string, start: number): number {
  for (let i = 0; i < text.length; i++) output[start + i] = text.charCodeAt(i)
  return text.length
}
function middle(output: Uint8Array, text: string, start: number): number {
  return leaf(output, text, start)
}
function outer(output: Uint8Array, text: string, start: number): number {
  return middle(output, text, start)
}
const output = new Uint8Array(3)
console.log(outer(output, 'abc', 0), output[0], output[1], output[2])
