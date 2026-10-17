// The string runtime walks UTF-8 eight ASCII bytes at a time, also past a
// string's first non-ASCII byte; `charAt` answers inside the ASCII prefix
// without measuring the whole string; an ASCII-literal RegExp is searched as
// bytes; and a RegExp that must open with one character is tried only where
// that character is. Every answer is Node's, over text whose eight-byte words
// straddle two-byte, three-byte, astral and lone-surrogate characters.
function codes(s: string): string {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i))
  return out.join('.')
}

const text = 'twenty ascii bytes!!é and then more ascii, ab\u{1F600}cdefghijklmn\uD83Dopqrstuvw\uDE00xyz € end'
console.log(
  [
    text.length,
    codes(text.charAt(19)),
    codes(text.charAt(20)),
    codes(text.charAt(21)),
    codes(text.charAt(47)),
    codes(text.charAt(48)),
    codes(text.charAt(62)),
    codes(text.charAt(72))
  ].join(' ')
)
console.log([codes(text.slice(17, 23)), codes(text.slice(44, 52)), codes(text.substring(60, 64)), codes(text.slice(70, 76))].join(' '))
console.log(
  [
    text.indexOf('a', 25),
    text.indexOf('ab', 30),
    text.indexOf('xyz', 50),
    text.indexOf(' end'),
    text.startsWith('cd', 47),
    text.startsWith('\uDE00cd', 46),
    text.startsWith('xyz', 70),
    text.startsWith('xyz', 71)
  ].join(' ')
)

const shader = '#define NUM_LIGHTS 2 // ü\nvec3 a[ NUM_LIGHTS ]; // \u{1F600}\nfloat b = NUM_LIGHTS;\n'
const lights = /NUM_LIGHTS/g
console.log(
  shader.replace(lights, '<$&>').split('\n').join('|') + ' ' + shader.replace(lights, '3').length + ' ' + shader.split(lights).length
)
const found: string[] = []
for (let m = lights.exec(shader); m !== null; m = lights.exec(shader)) found.push(m.index + ':' + lights.lastIndex)
console.log(found.join(','))
console.log(codes('éabéab'.replace(/ab/g, "[$`|$']")))

const pair = '\u{1F600}bc\u{1F600}bcd'
const single = /b/g
const word = /b\w/g
const starts: string[] = []
for (let start = 0; start <= 6; start++) {
  single.lastIndex = start
  word.lastIndex = start
  const a = single.exec(pair)
  const b = word.exec(pair)
  starts.push(`${a === null ? '-' : a.index}/${b === null ? '-' : b.index + ':' + codes(b[0])}`)
}
console.log(starts.join(' '))

const unroll =
  /#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g
const looped =
  '#if 1 // é\n#pragma unroll_loop_start\nfor ( int i = 0; i < 2; i ++ ) {\n\tx[ i ] = UNROLLED_LOOP_INDEX;\n}\n#pragma unroll_loop_end\n#endif\n'
console.log(
  codes(
    looped.replace(unroll, (match: string, start: string, end: string, snippet: string) => {
      let out = ''
      for (let i = Number(start); i < Number(end); i++)
        out += snippet.replace(/\[\s*i\s*\]/g, '[ ' + i + ' ]').replace(/UNROLLED_LOOP_INDEX/g, String(i))
      return out
    })
  )
)
const opened = /a(b|c)\w/g
console.log(
  ['\u{1F600}xabcxacdéabx'.replace(opened, '<$1>'), 'x|abz|acz'.split(/a(b|c)/).length, /c\b/.exec('abcé abc d')?.index].join(' ')
)

//! expect: 79 33 233 32 99 100 113 122
//! expect: 115.33.33.233.32.97 98.55357.56832.99.100.101.102.103 111.112.113.114 120.121.122.32.8364.32
//! expect: 36 43 70 75 true true true false
//! expect: #define <NUM_LIGHTS> 2 // ü|vec3 a[ <NUM_LIGHTS> ]; // 😀|float b = <NUM_LIGHTS>;| 49 4
//! expect: 8:18,34:44,64:74
//! expect: 233.91.233.124.233.97.98.93.233.91.233.97.98.233.124.93
//! expect: 2/2:98.99 2/2:98.99 2/2:98.99 6/6:98.99 6/6:98.99 6/6:98.99 6/6:98.99
//! expect: 35.105.102.32.49.32.47.47.32.233.10.10.9.120.91.32.48.32.93.32.61.32.48.59.10.10.9.120.91.32.49.32.93.32.61.32.49.59.10.10.35.101.110.100.105.102.10
//! expect: 😀x<b>x<c>é<b> 5 2
