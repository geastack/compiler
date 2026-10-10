//! expect: 0.5:0.5:0.5
//! expect: 0.75:0.75:0.75
//! expect: 17179869184:17179869184:17179869184

class NumericOrigin {
  amount = 0
  privateMarker = 'source'
}

const numericOriginal = new NumericOrigin()
const numericView: { amount: number } = numericOriginal
const numericChain: { amount: number } = numericView

numericView.amount = 0.5
console.log(`${numericOriginal.amount}:${numericView.amount}:${numericChain.amount}`)
numericChain.amount = 0.75
console.log(`${numericOriginal.amount}:${numericView.amount}:${numericChain.amount}`)
numericOriginal.amount = 17179869184
console.log(`${numericOriginal.amount}:${numericView.amount}:${numericChain.amount}`)
