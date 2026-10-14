//! expect: kept=attribute vec3 position;|attribute vec3 normal;|void main() {}
//! expect: count=3
// three's WebGLProgram joins its shader prefix through
// `[ ...lines ].filter( filterEmptyLine ).join( '\n' )`, a named callback whose
// parameter is the element. Every non-empty line must survive the filter.

function filterEmptyLine(string) {
  return string !== ''
}

const prefix = ['attribute vec3 position;', '', 'attribute vec3 normal;', '', 'void main() {}']
const kept = prefix.filter(filterEmptyLine)
console.log('kept=' + kept.join('|'))
console.log('count=' + kept.length)
