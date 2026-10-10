//! expect: bytes:2
//! expect: text:hi

// A bitfield library (a database client's optional dependency, plain JS):
// `this.pageSize = opts.pageSize || 1024` is `any`, so
// `opts.buffer.slice(i, i + this.pageSize)` hands a dynamic value to a host method that declares `number`. A
// pass-through host row lets C++ pick the host's overload from each
// argument's type, and no host overload takes the box: the argument enters
// the parameter the checker resolved, as it would at any other call.

let input: any = 'hi'
const bytes = new TextEncoder().encode(input)
console.log('bytes:' + bytes.length)
console.log('text:' + new TextDecoder().decode(bytes))
