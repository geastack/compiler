// @ts-nocheck
//! dynamic-fallback
//! expect: true 1.2.3 false 2.0.0
// semver's `if (version instanceof SemVer) return version`: a constructor that
// returns an object hands the caller that object instead of the new one.
class SemVer {
  constructor (version) {
    if (version instanceof SemVer) return version
    this.version = String(version)
  }
}
const a = new SemVer('1.2.3')
const b = new SemVer(a)
const c = new SemVer('2.0.0')
console.log(a === b, b.version, c === a, c.version)
