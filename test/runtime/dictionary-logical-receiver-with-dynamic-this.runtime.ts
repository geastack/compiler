//! expect: before
//! expect: after
//! expect: true

function update(this: any): string {
  const before = this.label
  this.label = 'after'
  return before
}
const dynamic: any = update
const holder: { update(): string } = { update: dynamic }
const entries: Record<string, string> = { label: 'before' }
console.log(holder.update.call(entries))
console.log(entries.label)
function same(this: any, original: any): boolean {
  return this === original
}
const dynamicSame: any = same
const check: { same(original: any): boolean } = { same: dynamicSame }
console.log(check.same.call(entries, entries))
