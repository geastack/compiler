const weights = [2.4, 0.2]
const items = [
  { weight: 2.4, quantity: 1 },
  { weight: 0.2, quantity: 3 }
]
console.log(weights.reduce((total, weight) => total + weight, 0).toFixed(2))
console.log(weights.reduceRight((total, weight) => total + weight, 0).toFixed(2))
console.log(items.reduce((total, item) => total + item.weight * item.quantity, 0).toFixed(2))
console.log(items.reduceRight((total, item) => total + item.weight * item.quantity, 0).toFixed(2))
