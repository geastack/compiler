// @ts-nocheck
//! expect: 1.2.3 undefined undefined undefined
// semver's `this.semver.version` where `semver` is a SemVer or its `ANY`
// symbol, and fastify's `logger?.levels` over `false | logger`: a primitive
// arm's own prototype chain holds no such key.
const ANY = Symbol('SemVer ANY')
class SemVer {
  constructor (version) {
    this.version = version
  }
}
const pick = (any) => (any ? ANY : new SemVer('1.2.3'))
const levelsOf = (logger) => logger?.levels
const count = (n) => (n > 0 ? n : { size: n })
console.log(pick(JSON.parse('false')).version, pick(JSON.parse('true')).version, levelsOf(JSON.parse('false') ? { levels: 1 } : false), count(JSON.parse('2')).size)
