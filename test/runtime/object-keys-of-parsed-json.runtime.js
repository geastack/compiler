//! expect: a,b,c x,y 1,3,b
// `JSON.parse` builds a Dictionary<Value>; its own keys are the table's, in
// OrdinaryOwnPropertyKeys order (integer keys ascending, then insertion), with
// expandos written afterwards included.
const parsed = JSON.parse('{"a":1}')
parsed.b = 2
const k = 'c'
parsed[k] = 3
const ordered = JSON.parse('{"b":1,"3":2,"1":3}')
console.log(Object.keys(parsed).join(','), Object.keys(JSON.parse('{"x":1,"y":2}')).join(','), Object.keys(ordered).join(','))
