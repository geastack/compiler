// @ts-nocheck
// A module-level one-slot array the program fills and clears again: three's
// WebGPUUtils `submit` keeps `const _commandList = [ null ]`, writes
// `_commandList[ 0 ] = command`, hands the array to the queue and writes
// `null` back. The checker types the literal `null[]`, so the command buffer
// written into it had no carrier to land in. A literal of nothing but `null`
// states no more than an empty one, its `null`s are element writes, and so is
// a write through a literal index: the element is `CommandBuffer | null`, and
// every read of an element (a binding, an argument, a return, a `for...of`)
// takes it rather than the checker's bare `null`.
class CommandBuffer {
  constructor(label) {
    this.label = label
  }
}
const _commandList = [null]
const submitted = []
/**
 * @param {?CommandBuffer} command - The command buffer, if any.
 * @return {string} Its label.
 */
function labelOf(command) {
  return command === null ? 'none' : command.label
}
function first() {
  return _commandList[0]
}
function drain() {
  for (const entry of _commandList) submitted.push(entry === null ? 'none' : entry.label)
}
function submit(command) {
  _commandList[0] = command
  const held = _commandList[0]
  submitted.push(held === null ? 'none' : held.label)
  submitted.push(labelOf(_commandList[0]))
  const returned = first()
  submitted.push(returned === null ? 'none' : returned.label)
  drain()
  _commandList[0] = null
}
submit(new CommandBuffer('a'))
submit(new CommandBuffer('b'))
drain()
console.log(submitted.join(), _commandList.length, _commandList[0] === null)
//! expect: a,a,a,a,b,b,b,b,none 1 true
