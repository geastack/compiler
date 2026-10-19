export {}

// A search that resumes inside the input (global, sticky, split, replace) must
// see the code unit before its start: `\b` and `\B` at the resume point
// depend on it, and so does a multiline `^` after a line terminator.
const word = /\b\w/g
const firsts: string[] = []
for (let found = word.exec('ab cd-ef'); found !== null; found = word.exec('ab cd-ef')) firsts.push(`${found.index}`)
//! expect: starts 0,3,6
console.log(`starts ${firsts.join(',')}`)

const sticky = /\bb/y
sticky.lastIndex = 1
const stickyInside = sticky.exec('ab')
const stickyAfterSpace = /\bb/y
stickyAfterSpace.lastIndex = 2
//! expect: sticky null 2:b
console.log(
  `sticky ${stickyInside === null ? 'null' : stickyInside.index} ${(() => {
    const found = stickyAfterSpace.exec('a b')
    return found === null ? 'null' : `${found.index}:${found[0]}`
  })()}`
)

const nonBoundary = /\B\w/y
nonBoundary.lastIndex = 1
const nb = nonBoundary.exec('ab')
//! expect: nonboundary 1:b
console.log(`nonboundary ${nb === null ? 'null' : `${nb.index}:${nb[0]}`}`)

//! expect: replace <a>b <c>d-<e>f [x][y] x-y
console.log(`replace ${'ab cd-ef'.replace(/\b\w/g, '<$&>')} ${'xy'.replace(/\w\B|\w\b/g, '[$&]')} ${'x y'.replace(/\b \b/g, '-')}`)

//! expect: split a,b,c ab|cd
console.log(`split ${'a b c'.split(/\b \b/).join(',')} ${'ab-cd'.split(/\b-\b/).join('|')}`)

//! expect: lines 0,2,4 0
const lines = 'a\nb\nc'
const positions: number[] = []
const lineStart = /^/gm
for (let found = lineStart.exec(lines); found !== null && positions.length < 5; found = lineStart.exec(lines)) {
  positions.push(found.index)
  lineStart.lastIndex = found.index + 1
}
const afterBreak = /^b/y
afterBreak.lastIndex = 1
console.log(`lines ${positions.join(',')} ${afterBreak.exec(lines) === null ? 0 : 1}`)
