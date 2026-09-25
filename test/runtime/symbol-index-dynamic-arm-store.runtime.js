//! dynamic-fallback
//! expect: 2 /api null false fastify app
// fastify's instance literal: computed symbol keys whose values include a box
// (`JSON.parse`), so the literal's symbol index keeps a `dynamic` arm beside
// the static ones. A value with no static arm of its own (a string, `null`, a
// boolean, a string array) is stored in that arm boxed, and the empty `[]`
// member is an array of boxes that pushes land in.
'use strict'
const kOptions = Symbol('options')
const kChildren = Symbol('children')
const kPrefix = Symbol('prefix')
const kSerializers = Symbol('serializers')
const kStarted = Symbol('started')
const kChain = Symbol('chain')
const instance = {
  [kOptions]: JSON.parse('{"limit":7}'),
  [kChildren]: [],
  [kPrefix]: '',
  [kSerializers]: null,
  [kStarted]: false,
  [kChain]: ['fastify'],
  name: 'app'
}
instance[kChildren].push('a', 'b')
instance[kPrefix] = '/api'
console.log(instance[kChildren].length, instance[kPrefix], instance[kSerializers], instance[kStarted], instance[kChain][0], instance.name)
