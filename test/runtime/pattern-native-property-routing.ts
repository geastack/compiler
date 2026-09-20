//! expect: 3 ab users
//! expect: true false true
//! expect: true true true
//! expect: g true false true api
//! emitted-has: gea::runtime::regex::dynamicGet
//! emitted-has: gea::runtime::regex::dynamicSet
//! emitted-has: gea::runtime::regex::dynamicHas
//! emitted-lacks: gea::nativeDynamicGet
//! emitted-lacks: gea::nativeDynamicSet
//! emitted-lacks: gea::nativeDynamicHas

// THE SUITE IS STRICT, AND A REFUSED WRITE THROWS.
//
// `test/runtime/tsconfig.json` sets `strict: true`, which implies
// `alwaysStrict` -- tsc parses every file in strict mode and emits a
// `'use strict'` prologue, so node throws on an assignment to an
// accessor-only property whether the file is a module or a script. This
// fixture is a script (no import, no export) and it still runs strict;
// the `module: ESNext` setting is not what decides that.
//
// So the plain-assignment path states the throw and catches it, while
// `Reflect.set` states the same refusal as a `false` return. Both spellings
// have to route through the RegExp sidecar rather than the generic dynamic
// path -- that is what the `emitted-has`/`emitted-lacks` lines pin.

function readPatternProperty(pattern: RegExp, key: string): unknown {
  return (pattern as any)[key]
}

function writePatternProperty(pattern: RegExp, key: string, value: unknown): boolean {
  try {
    ;(pattern as any)[key] = value
    return true
  } catch {
    return false
  }
}

function patternHas(pattern: RegExp, key: string): boolean {
  return key in pattern
}

const pattern = /ab/g
const wroteIndex = writePatternProperty(pattern, 'lastIndex', 3)
const wroteSource = writePatternProperty(pattern, 'source', 'changed')
const wroteRoute = writePatternProperty(pattern, 'route', 'users')
console.log(readPatternProperty(pattern, 'lastIndex'), pattern.source, readPatternProperty(pattern, 'route'))
console.log(wroteIndex, wroteSource, wroteRoute)
console.log(patternHas(pattern, 'source'), patternHas(pattern, 'test'), patternHas(pattern, 'route'))
console.log(
  Reflect.get(pattern, 'flags'),
  Reflect.has(pattern, 'exec'),
  Reflect.set(pattern, 'source', 'changed'),
  Reflect.set(pattern, 'route', 'api'),
  Reflect.get(pattern, 'route')
)
