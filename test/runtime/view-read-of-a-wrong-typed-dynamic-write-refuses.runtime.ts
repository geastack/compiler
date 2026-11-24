//! expect-abort
// The checked half of a view key answered from the expando: a runtime-keyed
// write through an `any` receiver stored a string under a key the reader's
// type says is boolean. The reader has no carrier for a string, so the read
// refuses out loud (the program dies) instead of answering a wrong value or
// reading it as absent. The well-typed read before it still answers.

export {}
interface SerializeOptions {
  raw?: boolean
  validate?: boolean
}
interface ClientOptions {
  name: string
  raw?: boolean
}
function install(target: any, key: string, value: unknown): void {
  target[key] = value
}
function resolve(options?: SerializeOptions): string {
  return [options?.raw ?? false, options?.validate ?? 'unset'].join(' ')
}
const suffix = String(Math.random()).slice(0, 0)
const good: ClientOptions = { name: 'g', raw: true }
install(good, `validate${suffix}`, false)
console.log(resolve(good))
const bad: ClientOptions = { name: 'b' }
install(bad, `validate${suffix}`, 'yes')
console.log(resolve(bad))
//! expect: true false
