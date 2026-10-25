//! expect: "{bad" dynamic SyntaxError: Expected property name or '}' in JSON at position 1 (line 1 column 2)
//! expect: "{" dynamic SyntaxError: Expected property name or '}' in JSON at position 1 (line 1 column 2)
//! expect: "{\"a\"" dynamic SyntaxError: Expected ':' after property name in JSON at position 4 (line 1 column 5)
//! expect: "{\"a\":" dynamic SyntaxError: Unexpected end of JSON input
//! expect: "{\"a\":1" dynamic SyntaxError: Expected ',' or '}' after property value in JSON at position 6 (line 1 column 7)
//! expect: "{\"a\":1," dynamic SyntaxError: Expected double-quoted property name in JSON at position 7 (line 1 column 8)
//! expect: "{\"a\":1,}" dynamic SyntaxError: Expected double-quoted property name in JSON at position 7 (line 1 column 8)
//! expect: "{\"a\":1,,}" dynamic SyntaxError: Expected double-quoted property name in JSON at position 7 (line 1 column 8)
//! expect: "{\"a\" 1}" dynamic SyntaxError: Expected ':' after property name in JSON at position 5 (line 1 column 6)
//! expect: "{\"a\"}" dynamic SyntaxError: Expected ':' after property name in JSON at position 4 (line 1 column 5)
//! expect: "{\"a\":}" dynamic SyntaxError: Unexpected token '}', "{"a":}" is not valid JSON
//! expect: "{\"a\":1 \"b\":2}" dynamic SyntaxError: Expected ',' or '}' after property value in JSON at position 7 (line 1 column 8)
//! expect: "{\"a\":1]" dynamic SyntaxError: Expected ',' or '}' after property value in JSON at position 6 (line 1 column 7)
//! expect: "{'a':1}" dynamic SyntaxError: Expected property name or '}' in JSON at position 1 (line 1 column 2)
//! expect: "{\"a\":{\"b\":1,}}" dynamic SyntaxError: Expected double-quoted property name in JSON at position 12 (line 1 column 13)
//! expect: "{\"a\":{bad}}" dynamic SyntaxError: Expected property name or '}' in JSON at position 6 (line 1 column 7)
//! expect: "[{\"a\":1},{bad}]" dynamic SyntaxError: Expected property name or '}' in JSON at position 10 (line 1 column 11)
//! expect: "[{\"a\":1,\"b\":2},{bad}]" dynamic SyntaxError: Expected property name or '}' in JSON at position 16 (line 1 column 17)
//! expect: "{}x" dynamic SyntaxError: Unexpected non-whitespace character after JSON at position 2 (line 1 column 3)
//! expect: "[" dynamic SyntaxError: Unexpected end of JSON input
//! expect: "[1" dynamic SyntaxError: Expected ',' or ']' after array element in JSON at position 2 (line 1 column 3)
//! expect: "[1," dynamic SyntaxError: Unexpected end of JSON input
//! expect: "[1,]" dynamic SyntaxError: Unexpected token ']', "[1,]" is not valid JSON
//! expect: "[,]" dynamic SyntaxError: Unexpected token ',', "[,]" is not valid JSON
//! expect: "[1,,2]" dynamic SyntaxError: Unexpected token ',', "[1,,2]" is not valid JSON
//! expect: "[1 2]" dynamic SyntaxError: Expected ',' or ']' after array element in JSON at position 3 (line 1 column 4)
//! expect: "[1}" dynamic SyntaxError: Expected ',' or ']' after array element in JSON at position 2 (line 1 column 3)
//! expect: "[1,2}" dynamic SyntaxError: Expected ',' or ']' after array element in JSON at position 4 (line 1 column 5)
//! expect: "[[1,2],[3,]]" dynamic SyntaxError: Unexpected token ']', "[[1,2],[3,]]" is not valid JSON
//! expect: "nul" dynamic SyntaxError: Unexpected end of JSON input
//! expect: "nulx" dynamic SyntaxError: Unexpected token 'x', "nulx" is not valid JSON
//! expect: "tru" dynamic SyntaxError: Unexpected end of JSON input
//! expect: "trUe" dynamic SyntaxError: Unexpected token 'U', "trUe" is not valid JSON
//! expect: "t" dynamic SyntaxError: Unexpected end of JSON input
//! expect: "nan" dynamic SyntaxError: Unexpected token 'a', "nan" is not valid JSON
//! expect: "{\"a\":tru}" dynamic SyntaxError: Unexpected token '}', "{"a":tru}" is not valid JSON
//! expect: "{\"a\":fals}" dynamic SyntaxError: Unexpected token '}', "{"a":fals}" is not valid JSON
//! expect: "[nul,1]" dynamic SyntaxError: Unexpected token ',', "[nul,1]" is not valid JSON
//! expect: "null x" dynamic SyntaxError: Unexpected non-whitespace character after JSON at position 5 (line 1 column 6)
//! expect: "true1" dynamic SyntaxError: Unexpected non-whitespace character after JSON at position 4 (line 1 column 5)
//! expect: "1." dynamic SyntaxError: Unterminated fractional number in JSON at position 2 (line 1 column 3)
//! expect: "1e" dynamic SyntaxError: Exponent part is missing a number in JSON at position 2 (line 1 column 3)
//! expect: "1e+" dynamic SyntaxError: Exponent part is missing a number in JSON at position 3 (line 1 column 4)
//! expect: "-" dynamic SyntaxError: No number after minus sign in JSON at position 1 (line 1 column 2)
//! expect: "-x" dynamic SyntaxError: No number after minus sign in JSON at position 1 (line 1 column 2)
//! expect: "01" dynamic SyntaxError: Unexpected number in JSON at position 1 (line 1 column 2)
//! expect: "-01" dynamic SyntaxError: Unexpected number in JSON at position 2 (line 1 column 3)
//! expect: "00" dynamic SyntaxError: Unexpected number in JSON at position 1 (line 1 column 2)
//! expect: "[01]" dynamic SyntaxError: Unexpected number in JSON at position 2 (line 1 column 3)
//! expect: "{\"a\":01}" dynamic SyntaxError: Unexpected number in JSON at position 6 (line 1 column 7)
//! expect: "+1" dynamic SyntaxError: Unexpected token '+', "+1" is not valid JSON
//! expect: ".5" dynamic SyntaxError: Unexpected token '.', ".5" is not valid JSON
//! expect: "1.5." dynamic SyntaxError: Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)
//! expect: "0x1" dynamic SyntaxError: Unexpected non-whitespace character after JSON at position 1 (line 1 column 2)
//! expect: "1-" dynamic SyntaxError: Unexpected non-whitespace character after JSON at position 1 (line 1 column 2)
//! expect: "-Infinity" dynamic SyntaxError: No number after minus sign in JSON at position 1 (line 1 column 2)
//! expect: "\"abc" dynamic SyntaxError: Unterminated string in JSON at position 4 (line 1 column 5)
//! expect: "{\"a\":\"x" dynamic SyntaxError: Unterminated string in JSON at position 7 (line 1 column 8)
//! expect: "\"a\u0001\"" dynamic SyntaxError: Bad control character in string literal in JSON at position 2 (line 1 column 3)
//! expect: "\"a\nb\"" dynamic SyntaxError: Bad control character in string literal in JSON at position 2 (line 1 column 3)
//! expect: "\"a\u0000b\"" dynamic SyntaxError: Bad control character in string literal in JSON at position 2 (line 1 column 3)
//! expect: "\"\\x\"" dynamic SyntaxError: Bad escaped character in JSON at position 2 (line 1 column 3)
//! expect: "\"\\u12G4\"" dynamic SyntaxError: Bad Unicode escape in JSON at position 5 (line 1 column 6)
//! expect: "\"\\u12\"" dynamic SyntaxError: Bad Unicode escape in JSON at position 5 (line 1 column 6)
//! expect: "\"\\uzz00\"" dynamic SyntaxError: Bad Unicode escape in JSON at position 3 (line 1 column 4)
//! expect: "\"\\u" dynamic SyntaxError: Bad Unicode escape in JSON at position 3 (line 1 column 4)
//! expect: "\"\\" dynamic SyntaxError: Unexpected end of JSON input
//! expect: "\"abc\\" dynamic SyntaxError: Unexpected end of JSON input
//! expect: "\"a\" \"b\"" dynamic SyntaxError: Unexpected non-whitespace character after JSON at position 4 (line 1 column 5)
//! expect: "" dynamic SyntaxError: Unexpected end of JSON input
//! expect: "   " dynamic SyntaxError: Unexpected end of JSON input
//! expect: "\n" dynamic SyntaxError: Unexpected end of JSON input
//! expect: "{\"a\":1}x" dynamic SyntaxError: Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)
//! expect: "{\"a\":1} x" dynamic SyntaxError: Unexpected non-whitespace character after JSON at position 8 (line 1 column 9)
//! expect: "{\"a\":1}\n\nx" dynamic SyntaxError: Unexpected non-whitespace character after JSON at position 9 (line 3 column 1)
//! expect: "{\"a\":1}\u0000" dynamic SyntaxError: Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)
//! expect: "undefined" dynamic SyntaxError: "undefined" is not valid JSON
//! expect: "NaN" dynamic SyntaxError: "NaN" is not valid JSON
//! expect: "Infinity" dynamic SyntaxError: "Infinity" is not valid JSON
//! expect: "[object Object]" dynamic SyntaxError: "[object Object]" is not valid JSON
//! expect: " undefined" dynamic SyntaxError: Unexpected token 'u', " undefined" is not valid JSON
//! expect: "undefinedx" dynamic SyntaxError: Unexpected token 'u', "undefinedx" is not valid JSON
//! expect: "\n{bad" dynamic SyntaxError: Expected property name or '}' in JSON at position 2 (line 2 column 2)
//! expect: "\n\n  {bad" dynamic SyntaxError: Expected property name or '}' in JSON at position 5 (line 3 column 4)
//! expect: "{\n  \"a\": 1,\n  \"b\" 2\n}" dynamic SyntaxError: Expected ':' after property name in JSON at position 18 (line 3 column 7)
//! expect: "{\r\n\"a\" 1}" dynamic SyntaxError: Expected ':' after property name in JSON at position 7 (line 2 column 5)
//! expect: "{\r\"a\" 1}" dynamic SyntaxError: Expected ':' after property name in JSON at position 6 (line 2 column 5)
//! expect: "{\n\r\"a\" 1}" dynamic SyntaxError: Expected ':' after property name in JSON at position 7 (line 3 column 5)
//! expect: "{\t\"a\" 1}" dynamic SyntaxError: Expected ':' after property name in JSON at position 6 (line 1 column 7)
//! expect: "{\n\"a\":1,\n}" dynamic SyntaxError: Expected double-quoted property name in JSON at position 9 (line 3 column 1)
//! expect: "{\"ä\":1,}" dynamic SyntaxError: Expected double-quoted property name in JSON at position 7 (line 1 column 8)
//! expect: "{\"日本\":1,}" dynamic SyntaxError: Expected double-quoted property name in JSON at position 8 (line 1 column 9)
//! expect: "{\"😀\":1,}" dynamic SyntaxError: Expected double-quoted property name in JSON at position 8 (line 1 column 9)
//! expect: "[\"ä\",]" dynamic SyntaxError: Unexpected token ']', "["ä",]" is not valid JSON
//! expect: "{\"a\":1,\"ä" dynamic SyntaxError: Unterminated string in JSON at position 9 (line 1 column 10)
//! expect: "{\"a\":1,\"日本" dynamic SyntaxError: Unterminated string in JSON at position 10 (line 1 column 11)
//! expect: "{\"a\":1}ä" dynamic SyntaxError: Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)
//! expect: "[ä]" dynamic SyntaxError: Unexpected token 'ä', "[ä]" is not valid JSON
//! expect: "[日]" dynamic SyntaxError: Unexpected token '日', "[日]" is not valid JSON
//! expect: "{\"a\":ä}" dynamic SyntaxError: Unexpected token 'ä', "{"a":ä}" is not valid JSON
//! expect: "[,1,2,3,4,5,6,7,8,9,10,11]" dynamic SyntaxError: Unexpected token ',', "[,1,2,3,4,5"... is not valid JSON
//! expect: "[1,2,3,4,5,6,,7,8,9,10,11,12]" dynamic SyntaxError: Unexpected token ',', ..."2,3,4,5,6,,7,8,9,10,"... is not valid JSON
//! expect: "[1,2,3,4,5,6,7,8,9,10,11,]" dynamic SyntaxError: Unexpected token ']', ..."8,9,10,11,]" is not valid JSON
//! expect: "[1,2,3,4,5,6,7,8,9,]" dynamic SyntaxError: Unexpected token ']', "[1,2,3,4,5,6,7,8,9,]" is not valid JSON
//! expect: "[1,2,3,4,5,6,7,8,9,10,]" dynamic SyntaxError: Unexpected token ']', ...",7,8,9,10,]" is not valid JSON
//! expect: "[1,      ]xxxxxxxxxxx" dynamic SyntaxError: Unexpected token ']', "[1,      ]xxxxxxxxx"... is not valid JSON
//! expect: "[1,       ]xxxxxxxxxxx" dynamic SyntaxError: Unexpected token ']', ..."[1,       ]xxxxxxxxx"... is not valid JSON
//! expect: "[1,        ]xxxxxxxxxxx" dynamic SyntaxError: Unexpected token ']', ..."1,        ]xxxxxxxxx"... is not valid JSON
//! expect: "[1,                 ]" dynamic SyntaxError: Unexpected token ']', ..."          ]" is not valid JSON
//! expect: "[1,                 ]x" dynamic SyntaxError: Unexpected token ']', ..."          ]x" is not valid JSON
//! expect: "[1,                  ]" dynamic SyntaxError: Unexpected token ']', ..."          ]" is not valid JSON
//! expect: "{\"a\":1}" dynamic ok object
//! expect: " {\"a\" : 2 } " dynamic ok object
//! expect: "[1,2]" dynamic ok object
//! expect: "null" dynamic ok object
//! expect: "\"x\"" dynamic ok string
//! expect: "1" dynamic ok number
//! expect: "{bad" point SyntaxError: Expected property name or '}' in JSON at position 1 (line 1 column 2)
//! expect: "{" point SyntaxError: Expected property name or '}' in JSON at position 1 (line 1 column 2)
//! expect: "{\"a\"" point SyntaxError: Expected ':' after property name in JSON at position 4 (line 1 column 5)
//! expect: "{\"a\":" point SyntaxError: Unexpected end of JSON input
//! expect: "{\"a\":1" point SyntaxError: Expected ',' or '}' after property value in JSON at position 6 (line 1 column 7)
//! expect: "{\"a\":1," point SyntaxError: Expected double-quoted property name in JSON at position 7 (line 1 column 8)
//! expect: "{\"a\":1,}" point SyntaxError: Expected double-quoted property name in JSON at position 7 (line 1 column 8)
//! expect: "{\"a\" 1}" point SyntaxError: Expected ':' after property name in JSON at position 5 (line 1 column 6)
//! expect: "{\"a\":tru}" point SyntaxError: Unexpected token '}', "{"a":tru}" is not valid JSON
//! expect: "{\"a\":\"x" point SyntaxError: Unterminated string in JSON at position 7 (line 1 column 8)
//! expect: "{\"a\":01}" point SyntaxError: Unexpected number in JSON at position 6 (line 1 column 7)
//! expect: "{\"a\":1,\"b\":2,x}" point SyntaxError: Expected double-quoted property name in JSON at position 13 (line 1 column 14)
//! expect: "[{\"a\":1,\"b\":2},{x}]" point SyntaxError: Expected property name or '}' in JSON at position 16 (line 1 column 17)
//! expect: "{\"a\":1}x" point SyntaxError: Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)
//! expect: "" point SyntaxError: Unexpected end of JSON input
//! expect: "undefined" point SyntaxError: "undefined" is not valid JSON
//! expect: "[1,]" point SyntaxError: Unexpected token ']', "[1,]" is not valid JSON
//! expect: "{\"a\":1}" point ok object
//! expect: "{\"b\":\"x\",\"a\":2}" point ok object
//! expect: "[" numbers SyntaxError: Unexpected end of JSON input
//! expect: "[1" numbers SyntaxError: Expected ',' or ']' after array element in JSON at position 2 (line 1 column 3)
//! expect: "[1," numbers SyntaxError: Unexpected end of JSON input
//! expect: "[1,]" numbers SyntaxError: Unexpected token ']', "[1,]" is not valid JSON
//! expect: "[,]" numbers SyntaxError: Unexpected token ',', "[,]" is not valid JSON
//! expect: "[1 2]" numbers SyntaxError: Expected ',' or ']' after array element in JSON at position 3 (line 1 column 4)
//! expect: "[1}" numbers SyntaxError: Expected ',' or ']' after array element in JSON at position 2 (line 1 column 3)
//! expect: "[01]" numbers SyntaxError: Unexpected number in JSON at position 2 (line 1 column 3)
//! expect: "[+1]" numbers SyntaxError: Unexpected token '+', "[+1]" is not valid JSON
//! expect: "[.5]" numbers SyntaxError: Unexpected token '.', "[.5]" is not valid JSON
//! expect: "[1.]" numbers SyntaxError: Unterminated fractional number in JSON at position 3 (line 1 column 4)
//! expect: "[1e]" numbers SyntaxError: Exponent part is missing a number in JSON at position 3 (line 1 column 4)
//! expect: "[-]" numbers SyntaxError: No number after minus sign in JSON at position 2 (line 1 column 3)
//! expect: "[\"a\u0001\"]" numbers SyntaxError: Bad control character in string literal in JSON at position 3 (line 1 column 4)
//! expect: "[1,2,3,4,5,6,7,8,9,10,11,]" numbers SyntaxError: Unexpected token ']', ..."8,9,10,11,]" is not valid JSON
//! expect: "{\"a\":1,}" numbers SyntaxError: Expected double-quoted property name in JSON at position 7 (line 1 column 8)
//! expect: "{bad" numbers SyntaxError: Expected property name or '}' in JSON at position 1 (line 1 column 2)
//! expect: "[1,2]" numbers ok 2
// ECMA-262 25.5.1 JSON.parse step 2 names the error (SyntaxError) and leaves
// its message to the engine. Node's message is V8's, and a compiled server
// hands that message to its clients (a body parser's 400 response), so the
// native reader reproduces V8's shapes exactly, as recorded from Node 24.22.1:
//   - positioned grammar errors carry `in JSON at position P (line L column C)`,
//     with P and the column counted in UTF-16 code units and `\n`, `\r` and
//     `\r\n` each ending a line;
//   - the first key of an object expects `property name or '}'`, a key after a
//     comma expects a `double-quoted property name`;
//   - an unexpected token names the code unit and quotes the source, whole when
//     it is under 21 code units and otherwise ten units of context around the
//     token; the whole source being `NaN`, `Infinity`, `undefined` or
//     `[object Object]` gets the short form; a literal mismatch is reported at
//     the first differing code unit;
//   - the end of the input, where a value should be, is bare
//     `Unexpected end of JSON input`, and text after the root reads
//     `after JSON at position`, not `in JSON at position`.
interface Point {
  a: number
}

const describe = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : 'non-error')

const parseDynamic = (text: string): string => {
  try {
    const value: unknown = JSON.parse(text)
    return `ok ${typeof value}`
  } catch (error) {
    return describe(error)
  }
}

const parsePoint = (text: string): string => {
  try {
    const point = JSON.parse(text) as Point
    return `ok ${typeof point}`
  } catch (error) {
    return describe(error)
  }
}

const parseNumbers = (text: string): string => {
  try {
    const numbers = JSON.parse(text) as number[]
    return `ok ${numbers.length}`
  } catch (error) {
    return describe(error)
  }
}

const dynamic = [
  '{bad',
  '{',
  '{"a"',
  '{"a":',
  '{"a":1',
  '{"a":1,',
  '{"a":1,}',
  '{"a":1,,}',
  '{"a" 1}',
  '{"a"}',
  '{"a":}',
  '{"a":1 "b":2}',
  '{"a":1]',
  "{'a':1}",
  '{"a":{"b":1,}}',
  '{"a":{bad}}',
  '[{"a":1},{bad}]',
  '[{"a":1,"b":2},{bad}]',
  '{}x',
  '[',
  '[1',
  '[1,',
  '[1,]',
  '[,]',
  '[1,,2]',
  '[1 2]',
  '[1}',
  '[1,2}',
  '[[1,2],[3,]]',
  'nul',
  'nulx',
  'tru',
  'trUe',
  't',
  'nan',
  '{"a":tru}',
  '{"a":fals}',
  '[nul,1]',
  'null x',
  'true1',
  '1.',
  '1e',
  '1e+',
  '-',
  '-x',
  '01',
  '-01',
  '00',
  '[01]',
  '{"a":01}',
  '+1',
  '.5',
  '1.5.',
  '0x1',
  '1-',
  '-Infinity',
  '"abc',
  '{"a":"x',
  '"a\u0001"',
  '"a\nb"',
  '"a\u0000b"',
  '"\\x"',
  '"\\u12G4"',
  '"\\u12"',
  '"\\uzz00"',
  '"\\u',
  '"\\',
  '"abc\\',
  '"a" "b"',
  '',
  '   ',
  '\n',
  '{"a":1}x',
  '{"a":1} x',
  '{"a":1}\n\nx',
  '{"a":1}\u0000',
  'undefined',
  'NaN',
  'Infinity',
  '[object Object]',
  ' undefined',
  'undefinedx',
  '\n{bad',
  '\n\n  {bad',
  '{\n  "a": 1,\n  "b" 2\n}',
  '{\r\n"a" 1}',
  '{\r"a" 1}',
  '{\n\r"a" 1}',
  '{\t"a" 1}',
  '{\n"a":1,\n}',
  '{"ä":1,}',
  '{"日本":1,}',
  '{"😀":1,}',
  '["ä",]',
  '{"a":1,"ä',
  '{"a":1,"日本',
  '{"a":1}ä',
  '[ä]',
  '[日]',
  '{"a":ä}',
  '[,1,2,3,4,5,6,7,8,9,10,11]',
  '[1,2,3,4,5,6,,7,8,9,10,11,12]',
  '[1,2,3,4,5,6,7,8,9,10,11,]',
  '[1,2,3,4,5,6,7,8,9,]',
  '[1,2,3,4,5,6,7,8,9,10,]',
  '[1,      ]xxxxxxxxxxx',
  '[1,       ]xxxxxxxxxxx',
  '[1,        ]xxxxxxxxxxx',
  '[1,                 ]',
  '[1,                 ]x',
  '[1,                  ]',
  '{"a":1}',
  ' {"a" : 2 } ',
  '[1,2]',
  'null',
  '"x"',
  '1'
]
for (const text of dynamic) console.log(`${JSON.stringify(text)} dynamic ${parseDynamic(text)}`)

const points = [
  '{bad',
  '{',
  '{"a"',
  '{"a":',
  '{"a":1',
  '{"a":1,',
  '{"a":1,}',
  '{"a" 1}',
  '{"a":tru}',
  '{"a":"x',
  '{"a":01}',
  '{"a":1,"b":2,x}',
  '[{"a":1,"b":2},{x}]',
  '{"a":1}x',
  '',
  'undefined',
  '[1,]',
  '{"a":1}',
  '{"b":"x","a":2}'
]
for (const text of points) console.log(`${JSON.stringify(text)} point ${parsePoint(text)}`)

const arrays = [
  '[',
  '[1',
  '[1,',
  '[1,]',
  '[,]',
  '[1 2]',
  '[1}',
  '[01]',
  '[+1]',
  '[.5]',
  '[1.]',
  '[1e]',
  '[-]',
  '["a\u0001"]',
  '[1,2,3,4,5,6,7,8,9,10,11,]',
  '{"a":1,}',
  '{bad',
  '[1,2]'
]
for (const text of arrays) console.log(`${JSON.stringify(text)} numbers ${parseNumbers(text)}`)
