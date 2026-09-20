//! expect: 18
//! emitted-lacks: std::string v

function readStable(input: string): number {
  const text = input
  let total = 0
  for (let i = 0; i < 3; i++) total += text.length
  return total
}

console.log(readStable('abcdef'))
