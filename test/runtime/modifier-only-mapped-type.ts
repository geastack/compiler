// `type Mutable<T> = { -readonly [K in keyof T]: T[K] }` (tsc's own, used
// throughout `nodeFactory.ts`) states the same storage as `T`: `readonly` is a
// permission, not a physical fact. A mapped type that changes a `?` or the key
// set is a different object and keeps the general path.
//! expect: id b
//! expect: partial-present a
//! expect: picked id
interface Token {
  readonly kind: string
  readonly text: string
}
type Mutable<T extends object> = { -readonly [K in keyof T]: T[K] }

const token: Mutable<Token> = { kind: 'id', text: 'a' }
token.text = 'b'
const frozen: Readonly<Mutable<Token>> = token
console.log(frozen.kind, frozen.text)

type Loose<T extends object> = { [K in keyof T]?: T[K] }
const loose: Loose<Token> = { kind: 'a' }
console.log(loose.text === undefined ? 'partial-present ' + (loose.kind ?? '-') : 'partial-wrong')

type Kind<T extends { kind: string }> = { [K in 'kind']: T[K] }
const picked: Kind<Token> = { kind: 'id' }
console.log('picked', picked.kind)
