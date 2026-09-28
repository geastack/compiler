// @ts-nocheck
//! dynamic-fallback
//! expect: Function AsyncFunction GeneratorFunction Function AsyncFunction
// The same read off functions a dynamic cell holds: fastify's hook and route
// handler checks run on values it keeps untyped.
function plain () {}
async function later () {}
function * counting () { yield 1 }
const holder = JSON.parse('{}')
holder.list = [plain, later, counting, () => 1, async () => 1]
console.log(holder.list.map((fn) => fn.constructor.name).join(' '))
