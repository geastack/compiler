//! expect-refusal: a contextual dictionary reader has an unproved mutation or escape
const narrow: Record<string, string> = { key: 'first' }
const wider: Record<string, string | number> = narrow
wider.key = 42
console.log(narrow.key)
