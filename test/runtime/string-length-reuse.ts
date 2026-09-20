//! expect: 8 2 0 4
//! emitted-once: gea::runtime::string::utf16Length(gea_arg_0)

function repeatedLength(text: string): number {
  const first = text.length
  if (first > 1) return first + text.length
  return text.length * 2
}
console.log(repeatedLength('abcd'), repeatedLength('x'), repeatedLength(''), repeatedLength('😀'))
