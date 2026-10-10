//! expect: keys:0,1,2
//! expect: size:12

// A binary-document serializer's size calculation: `for (let i = 0; i < object.length; i++)
// totalLength += calculateElement(i.toString(), object[i], ...)`. The counter
// is proven integral and carried as the backend's narrowed integer, and
// `Number.prototype.toString` must answer for that carrier exactly as it does
// for a double.

function calculateElement(name: string, value: unknown): number {
  return name.length + String(value).length + 1
}

function calculate(object: unknown[]): { keys: string[]; size: number } {
  const keys: string[] = []
  let size = 0
  for (let i = 0; i < object.length; i++) {
    const name = i.toString()
    keys.push(name)
    size += calculateElement(name, object[i])
  }
  return { keys, size }
}

const result = calculate(['a', true, 7])
console.log('keys:' + result.keys.join(','))
console.log('size:' + result.size)
