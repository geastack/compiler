//! expect: shader=main(){ #include <common> uniform float uTime; #include <begin_vertex> pos.y += 1.0; }
//! expect: substitution=a[-|a|b-c|$]b-c
//! expect: miss=a-b-c
//! expect: global=a+b+c
//! expect: first=a-<b>-c
//! expect: coerced=a-b-7
//! expect: undefined=a-b-c

// A shader patch hook whose argument is untyped (three's `onBeforeCompile`
// as a JS program writes it): `.replace` is read off a boxed string, so it
// must come from the dynamic String.prototype, not the typed call path.
function patch(sh: any): void {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common> uniform float uTime;')
    .replace('#include <begin_vertex>', `#include <begin_vertex> ${sh.hook || ''}`)
}

const sh: any = { vertexShader: 'main(){ #include <common> #include <begin_vertex> }', hook: 'pos.y += 1.0;' }
patch(sh)
console.log('shader=' + sh.vertexShader)

const text: any = 'a-b-c'
const pattern: any = /c$/
console.log('substitution=' + text.replace('-', "[$&|$`|$'|$$]"))
console.log('miss=' + text.replace('x', 'y'))
console.log('global=' + text.replace(/(\w)-/g, '$1+'))
console.log('first=' + text.replace(/b/, '<$&>'))
console.log('coerced=' + text.replace(pattern, 7))
console.log('undefined=' + text.replace(undefined, 'u'))
