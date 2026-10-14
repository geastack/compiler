//! expect: prefix=#define attribute in|#define varying out|uniform mat4 m;|attribute vec3 position;
//! expect: grown=abcabc!
// three's WebGLProgram wraps its prefix for GLSL3 with
// `prefixVertex = [ ...defines ].join( '\n' ) + '\n' + prefixVertex`: the
// right-hand side reads the very string being assigned. Building the result
// in place adopted the defines into `prefixVertex` before reading it, so the
// original prefix vanished and the defines appeared twice.

function wrap(parameters) {
  let prefixVertex = ['uniform mat4 m;', 'attribute vec3 position;'].join('\n')
  if (parameters.glsl3 !== true) {
    prefixVertex = ['#define attribute in', '#define varying out'].join('\n') + '\n' + prefixVertex
  }
  return prefixVertex
}
console.log('prefix=' + wrap({ glsl3: false }).split('\n').join('|'))
let grown = 'abc'
grown = grown + grown + '!'
console.log('grown=' + grown)
