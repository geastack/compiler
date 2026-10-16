const abrupt = new Error('stop')
function key(): 'method' { console.log('key'); throw abrupt }
function staticEffect(): number { console.log('STATIC_EFFECT_MUST_NOT_RUN'); return 1 }
try {
  class C { static before = staticEffect(); [key()]() {} }
  console.log('DEFINITION_AFTER_MUST_NOT_RUN')
} catch (error) { console.log('caught', error === abrupt) }
//! expect: key
//! expect: caught true
