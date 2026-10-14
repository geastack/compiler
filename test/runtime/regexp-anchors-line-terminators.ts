export {}

// `^` and `$` without `m` match only at the ends of the input, never at a line
// terminator inside it (ES 22.2.2.6); with `m` they match at both. A standard
// library without LWG 2503's `multiline` matches every pattern multiline, and
// the runtime rewrites the anchors there -- these are Node's answers either way.
const esc = (text: string): string => text.split('\n').join('\\n')
const show = (match: RegExpExecArray | null): string => (match === null ? 'null' : `${match.index}:${esc(match[0])}`)

//! expect: tests false false true true false false false
console.log(
  `tests ${/^a/.test('x\na')} ${/a$/.test('a\nb')} ${/^a/m.test('x\na')} ${/a$/m.test('a\nb')} ${/^a(?!b)/.test('x\na')} ${/x.$/.test(
    'xé\nx'
  )} ${/^.$/u.test('\u00e9\n')}`
)

//! expect: exec 3:b 2:b 0:a\nb null 0:aa null 2:xy null
console.log(
  `exec ${show(/^a|b/.exec('x\nab'))} ${show(/a$|b/.exec('a\nb'))} ${show(/a[\s\S]*?$/.exec('a\nb'))} ${show(
    /x?^(a)\1/.exec('x\naa')
  )} ${show(/x?^(a)\1/.exec('aa'))} ${show(/(?:^a\n)+b/.exec('a\na\nb'))} ${show(/(?:x|^)y/.exec('q\nxy'))} ${show(
    /x(?=$)/.exec('x\n')
  )}`
)

// A `^` reachable after consuming takes the rewrite's extra capture group; the
// program's own groups, named ones included, must not move.
const captured = /x?^(a)(?<second>b)/.exec('ab')
//! expect: captures a b b
console.log(`captures ${captured === null ? 'null' : `${captured[1]} ${captured[2]} ${captured.groups?.second}`}`)

//! expect: replace <a>\nb\nc a\nb\n<c> <a>\n<b>\n<c> <a>\n<b>\n<c> <>a\nb<> <>a<>\n<>b<>
console.log(
  `replace ${esc('a\nb\nc'.replace(/^\w/g, '<$&>'))} ${esc('a\nb\nc'.replace(/\w$/g, '<$&>'))} ${esc(
    'a\nb\nc'.replace(/^\w/gm, '<$&>')
  )} ${esc('a\nb\nc'.replace(/\w$/gm, '<$&>'))} ${esc('a\nb'.replace(/^|$/g, '<>'))} ${esc('a\nb'.replace(/^|$/gm, '<>'))}`
)

//! expect: split 1 3 1 3 ,a,ab 0 1
console.log(
  `split ${'a\nb\nc'.split(/^/).length} ${'a\nb\nc'.split(/^/m).length} ${'a\nb\nc'.split(/$/).length} ${
    'a\nb\nc'.split(/$/m).length
  } ${'aab'.split(/x?^(a)/).join(',')} ${''.split(/^$/).length} ${''.split(/^a/).length}`
)

const sticky = /^a/y
sticky.lastIndex = 2
const stickyMiss = sticky.exec('x\na')
const stickyEnd = /b$/y
stickyEnd.lastIndex = 2
const stickyHit = stickyEnd.exec('a\nb')
//! expect: sticky null 0 2:b 3
console.log(`sticky ${show(stickyMiss)} ${sticky.lastIndex} ${show(stickyHit)} ${stickyEnd.lastIndex}`)

const global = /^a/g
const first = global.exec('aa\na')
const second = global.exec('aa\na')
//! expect: global 0:a null 0 1 2 1 2
console.log(
  `global ${show(first)} ${show(second)} ${global.lastIndex} ${'aa\na'.match(/^a/g)?.length} ${'aa\na'.match(/^a/gm)?.length} ${
    'a\na'.match(/a$/g)?.length
  } ${'a\na'.match(/a$/gm)?.length}`
)

// `String.prototype.matchAll` has no rendering in this backend (it answers an
// iterator object); its walk is the global `exec` loop.
const starts = (text: string, pattern: RegExp): string => {
  const found: number[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    found.push(match.index)
    if (match[0] === '') pattern.lastIndex++
  }
  return found.join(',')
}
//! expect: walk 0 0,2,4 4 0,2,4 0,5 0,1,2,3,4,5
console.log(
  `walk ${starts('a\nb\nc', /^\w/g)} ${starts('a\nb\nc', /^\w/gm)} ${starts('a\nb\nc', /\w$/g)} ${starts('a\nb\nc', /\w$/gm)} ${starts(
    'a\nb\nc',
    /^|$/g
  )} ${starts('a\nb\nc', /^|$/gm)}`
)
