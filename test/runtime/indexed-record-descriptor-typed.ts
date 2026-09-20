interface Numbers {
  fixed: number
  [key: string]: number
}
const numbers: Numbers = { fixed: 1, answer: 42 }
const descriptor = Object.getOwnPropertyDescriptor(numbers, 'answer') as { value: number } | undefined
console.log(descriptor?.value)
