// node:zlib's zstd options as a database driver hands them over:
// `{ params: { [constants.ZSTD_c_compressionLevel]: level } }`, a
// number-to-number literal, read by a callee that declares the wider
// `number | boolean` values node admits. The callee only reads the
// dictionary, so it crosses as a read-only converted view. A
// `typeof zlib.zstdCompress === 'function'` test elsewhere reads the function
// as a value, but observing a function's type neither calls it nor exposes
// its parameters, so it does not make the view's reader unproved.

import * as zlib from './_zstd-like-codec'

const compress = (input: string, level?: number): Promise<string> => {
  const options = level == null ? {} : { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } }
  return new Promise((resolve, reject) => {
    zlib.zstdCompress(input, options, (error, result) => {
      if (error) return reject(error)
      resolve(result)
    })
  })
}

async function main(): Promise<void> {
  console.log('available', typeof zlib.zstdCompress === 'function')
  console.log(await compress('a'))
  console.log(await compress('b', 19))
}
void main()
//! expect: available true
//! expect: a
//! expect: b:100=19
