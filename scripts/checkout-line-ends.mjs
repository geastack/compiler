// The compiler's checks compare bytes that include line ends: the emitted-set
// gate (Function.prototype.toString hands a function's source back, line ends
// and all), the tests that pin the C++ runtime's text, and format:check. The
// repository is LF, and on Windows Git's core.autocrlf (on by default there)
// turns a checkout into CRLF, so those checks would read a different program.
// A Windows checkout must therefore be made without that conversion.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const probe = 'src/targets/cpp/runtime/gea_runtime.h'

/** Throws, saying how to fix it, when the compiler checkout at `root` has CRLF line ends. */
export const assertLfCheckout = (root) => {
  if (!readFileSync(join(root, probe)).includes(13)) return
  throw new Error(
    `${root} is checked out with CRLF line ends (Git's core.autocrlf converted ${probe}). ` +
      'The gate, the runtime-shape tests and format:check compare LF bytes. Clone it again without the conversion:\n' +
      '  git clone -c core.autocrlf=false <the compiler repository URL>'
  )
}
