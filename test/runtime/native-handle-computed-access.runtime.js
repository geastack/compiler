// @ts-nocheck
// test262's propertyHelper reads a host intrinsic's member back through a
// RUNTIME key (`obj[name]`), writes a fresh value through it to probe
// writability, and deletes through it to probe configurability. Each is a
// static name-comparison chain over Math's classified member table in front of
// a per-protocol runtime sidecar; the read is a `gea::Value` because the
// checker types a runtime-keyed read of Math as `any` (a number constant or
// one of forty function objects, decided by the key).
function read(obj, name) {
  return obj[name]
}
// Both probes CATCH, which is what test262's own propertyHelper does and what
// this build requires: `module: ESNext` makes every file an ES module, and an
// ES module is strict in its entirety (ECMA-262 11.2.2), so a store to a
// non-writable property and a delete of a non-configurable one THROW rather
// than answering false. Verified against real `node` on this file's own
// emitted module -- the sloppy-mode answers the earlier version pinned are not
// reachable under the module setting this suite compiles with.
function write(obj, name, value) {
  try {
    obj[name] = value
  } catch (error) {
    return false
  }
  return obj[name] === value
}
function remove(obj, name) {
  try {
    return delete obj[name]
  } catch (error) {
    return false
  }
}
console.log(typeof read(Math, 'SQRT2'), read(Math, 'SQRT2') === Math.SQRT2, typeof read(Math, 'pow'), read(Math, 'nope') === undefined)
//! expect: number true function true
// SQRT2 is non-writable: the store is ignored and the read still answers the
// constant. A fresh key lands in the sidecar and reads back.
console.log(write(Math, 'SQRT2', 'x'), read(Math, 'SQRT2') === Math.SQRT2, write(Math, 'fresh', 7), read(Math, 'fresh'))
//! expect: false true true 7
// SQRT2 is non-configurable; the sidecar key and an absent key delete fine,
// and a deleted key reads as absent afterwards.
console.log(remove(Math, 'SQRT2'), remove(Math, 'fresh'), read(Math, 'fresh') === undefined, remove(Math, 'nope'))
//! expect: false true true true
