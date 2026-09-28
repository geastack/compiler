// @ts-nocheck
//! expect: options:2 stack:false TypeError
// ret's tokenizer: `lastGroup = groupStack.pop()` leaves the cell possibly
// absent, and `delete lastGroup.stack` runs on it. ToObject throws for the
// absence; a present object deletes its own key.
const groupStack = [{ stack: [1], options: undefined }]
let lastGroup = groupStack.pop()
lastGroup.options = [lastGroup.stack, []]
delete lastGroup.stack
const out = ['options:' + lastGroup.options.length, 'stack:' + ('stack' in lastGroup)]
lastGroup = groupStack.pop()
try {
  delete lastGroup.stack
} catch (error) {
  out.push(error.name)
}
console.log(out.join(' '))
