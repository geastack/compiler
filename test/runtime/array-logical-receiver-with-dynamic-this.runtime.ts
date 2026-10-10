//! expect: 2

// The erased callable reaches a genuine unknown-this boundary lazily; its
// retained native Array payload preserves length and index operations.
function inspect(this: any): number {
  return this.length
}

const dynamic: any = inspect
const holder: { read(): number } = { read: dynamic }
const read = holder.read
console.log(read.call([1, 2]))
