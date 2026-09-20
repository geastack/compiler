import negativeArray from './negative-array.js'

const original = ['a', 'b', 'c']
const array = negativeArray(original)
console.log(array[-1])
array[-1] = 'z'
console.log(array[2], original[2])
original[0] = 'changed'
console.log(array[-3], array.length, Array.isArray(array))
