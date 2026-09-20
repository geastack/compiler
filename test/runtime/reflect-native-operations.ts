interface IndexedNumbers {
  fixed: number
  [key: string]: number | undefined
}
const values: IndexedNumbers = { fixed: 42, extra: 43 }
console.log(Reflect.has(values, 'fixed'))
console.log(Reflect.get(values, 'fixed'))
console.log(Reflect.set(values, 'fixed', 44))
console.log(Reflect.get(values, 'fixed'))
console.log(Reflect.has(values, 'extra'))
console.log(Reflect.get(values, 'extra'))
console.log(Reflect.set(values, 'extra', 45))
console.log(Reflect.get(values, 'extra'))
console.log(Reflect.deleteProperty(values, 'extra'))
console.log(Reflect.has(values, 'extra'))
console.log(Reflect.get(values, 'extra'))
Object.freeze(values)
console.log(Reflect.set(values, 'fixed', 99))
console.log(Reflect.set(values, 'extra', 99))
console.log(Reflect.get(values, 'fixed'))
