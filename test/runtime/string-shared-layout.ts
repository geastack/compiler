//! expect: 294 1188 112408 111849 0
//! emitted-has: gea_shared_string_layout_
//! emitted-lacks: utf16Length(
//! emitted-once: = gea::runtime::string::utf16Metadata(

// Separate method sites share immutable layout information, while each retains
// its own cursor. Backwards reads must still reconstruct surrogate pairs.
function scan(text: string): number {
  let sum = 0
  for (let i = 0; i < text.length; i++) {
    sum += text.charCodeAt(i) + text.charCodeAt(text.length - i - 1)
  }
  return sum
}

console.log(scan('abc') / 2, scan('éλ') / 2, scan('a😀z') / 2, scan('\uD800\uDC00é') / 2, scan(''))
