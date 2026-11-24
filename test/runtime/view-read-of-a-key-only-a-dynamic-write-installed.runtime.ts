// A record passed where a wider options shape is expected is read through a
// live view of the original allocation. A key the original's own type does
// not declare but a write under a runtime key installed on it reads back
// through that view as the value written; a key nobody wrote reads undefined.

export {}
interface SerializeOptions {
  raw?: boolean
  validate?: boolean
  checked?: boolean
}
interface ClientOptions {
  name: string
  raw?: boolean
}
function install(target: any, key: string, value: unknown): void {
  target[key] = value
}
function resolve(options?: SerializeOptions): string {
  return [options?.raw ?? false, options?.validate ?? 'unset', options?.checked ?? 'unset'].join(' ')
}
const suffix = String(Math.random()).slice(0, 0)
const client: ClientOptions = { name: 'c', raw: true }
install(client, `validate${suffix}`, true)
console.log(resolve(client))
//! expect: true true unset
