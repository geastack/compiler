//! expect: shader #version 300 es|#ext|#define attribute in|precision highp float;
//! expect: prefix #ext|#define attribute in|precision highp float;
//! expect: local x-y:old
//! expect: empty [p-q|]
//! expect: length m-n4
//! expect: template a+b<tail>
//! expect: loop 221100z
//! expect: module a.b v1

// three's WebGLProgram.js builds `prefixVertex = [...].join('\n') + '\n' +
// prefixVertex`. The joined head is a temporary nothing reads afterwards, so
// the store adopted its buffer into the cell and then appended the pieces.
// One piece is the cell itself, which by then held the head: every GLSL3
// prefix came out as its define lines twice, without the precision and
// uniform lines, and no shader program in Sakura Fantasy linked.
//
// Verified against Node: prints the lines above.

/**
 * @param {boolean} raw
 * @param {string} ext
 */
function shaderSource(raw, ext) {
  let prefix = raw ? '' : 'precision highp float;'
  if (!raw) prefix = [ext, '#define attribute in'].join('\n') + '\n' + prefix
  return { glsl: '#version 300 es\n' + prefix, prefix: () => prefix }
}
const shader = shaderSource(false, '#ext')
console.log('shader', shader.glsl.split('\n').join('|'))
console.log('prefix', shader.prefix().split('\n').join('|'))

/** @param {string[]} parts */
function prependToLocal(parts) {
  let s = 'old'
  s = parts.join('-') + ':' + s
  return s
}
console.log('local', prependToLocal(['x', 'y']))

/** @param {string[]} parts */
function prependToEmpty(parts) {
  let e = ''
  e = parts.join('-') + '|' + e
  return e
}
console.log('empty', `[${prependToEmpty(['p', 'q'])}]`)

/** @param {string[]} parts */
function appendOwnLength(parts) {
  let n = 'four'
  n = parts.join('-') + n.length
  return n
}
console.log('length', appendOwnLength(['m', 'n']))

/** @param {string[]} parts */
function wrapInTemplate(parts) {
  let t = 'tail'
  t = `${parts.join('+')}<${t}>`
  return t
}
console.log('template', wrapInTemplate(['a', 'b']))

/** @param {number} count */
function prependInLoop(count) {
  let acc = 'z'
  for (let i = 0; i < count; i++) acc = [i, i].join('') + acc
  return acc
}
console.log('loop', prependInLoop(3))

let banner = 'v1'
banner = ['a', 'b'].join('.') + ' ' + banner
console.log('module', banner)
