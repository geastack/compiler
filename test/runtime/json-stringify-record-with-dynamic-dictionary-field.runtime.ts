// A record with a `Record<string, any>` field, serialized. A database client's
// command documents carry open `Document` members inside closed option
// records, and `JSON.stringify` of one renders the record's generated
// `gea_json_write`/`gea_json_read` overload PAIR: the write half has a native
// answer for a `dictionary(string, dynamic)` field, and the read half used to
// name a `gea_json_read` for the dictionary that did not exist, so the program
// certified and then failed to compile under clang.
//! expect: {"name":"ping","meta":{"a":1,"b":"two","c":[true,null],"d":{"e":3}}}
//! expect: ping 1 two 3

interface Command {
  name: string
  meta: Record<string, any>
}

const command: Command = { name: 'ping', meta: { a: 1, b: 'two', c: [true, null], d: { e: 3 } } }
const text = JSON.stringify(command)
// node prints: {"name":"ping","meta":{"a":1,"b":"two","c":[true,null],"d":{"e":3}}}
console.log(text)
const back = JSON.parse(text) as Command
// node prints: ping 1 two 3
console.log(back.name, back.meta['a'], back.meta['b'], back.meta['d'].e)
