//! expect: true
//! expect: after:shared
//! expect: later

type Tables = Record<string, string> | Record<string, string[]>

const identity = (value: Tables): Tables => value
const table: Tables = {}
table.first = 'before'
const alias = identity(table)
alias.first = ['after', 'shared']
table.second = 'later'

console.log(table === alias)
const first = identity(table).first
console.log(first === undefined ? 'missing' : typeof first === 'string' ? first : first.join(':'))
console.log(alias.second)
