// What the global object's run-time property table does answer: a key the host
// states absent, a key nothing declares, and a key the program installed.
;(globalThis as unknown as Record<string, number>)['installedFlag'] = 1
console.log('MutationObserver' in globalThis, 'notDeclaredAnywhere' in globalThis)
console.log('installedFlag' in globalThis, Object.hasOwn(globalThis, 'installedFlag'))
//! expect: false false
//! expect: true true
export {}
