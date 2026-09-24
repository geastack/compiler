import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { cxx } from '../scripts/cxx.mjs'

/**
 * What `-fsanitize=address` needs that clang does not ship on Windows.
 *
 * MSVC's STL annotates `std::string` and `std::vector` buffers for the
 * sanitizer, and asks the linker for `stl_asan.lib` whenever it is compiled
 * under one. That library comes from Visual Studio's optional "C++
 * AddressSanitizer" component, not from LLVM, and where it is missing for this
 * architecture the link fails before any test has run -- so the two build
 * steps that sanitize could not run at all.
 *
 * `_DISABLE_STL_ANNOTATION` turns off exactly those container annotations and
 * nothing else: heap, stack, use-after-free and the whole of UBSan are
 * unaffected. What it costs is detecting an overflow that stays INSIDE a
 * string's or vector's own allocation. That is a real reduction, so it is
 * applied only where the library is actually absent, and it says so.
 *
 * Install the component to get it back:
 *
 *   "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\setup.exe" modify \
 *     --installPath "<VS install>" --add Microsoft.VisualStudio.Component.VC.ASAN
 */
// Both answers come from the compiler that will build the test, not from a
// guess at where one is installed: clang links against the MSVC toolset it
// found for itself, and loads the sanitizer runtime from its own resource
// directory. Looking only under `Program Files` missed Visual Studio's own
// clang, and any installation on another drive, so a sanitized binary linked
// and then could not start (0xC0000135, the ASan DLL not found).
const clangOutput = (args) => {
  const result = spawnSync(cxx, args, { encoding: 'utf8', input: '' })
  return result.status === 0 ? `${result.stdout}${result.stderr}` : null
}

const msvcStlAsanIsInstalled = () => {
  const verbose = clangOutput(['-v', '-fsyntax-only', '-x', 'c++', '-'])
  const include = verbose
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /[\\/]VC[\\/]Tools[\\/]MSVC[\\/][^\\/]+[\\/]include$/i.test(line))
  if (!include) return false
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
  return existsSync(join(dirname(include), 'lib', architecture, 'stl_asan.lib'))
}

/** The directory holding clang's own sanitizer runtime, which the built binary loads at run time. */
const clangRuntimeDirectory = () => {
  const resource = clangOutput(['-print-resource-dir'])?.trim()
  if (!resource) return null
  const windows = join(resource, 'lib', 'windows')
  return existsSync(windows) ? windows : null
}

const degraded = process.platform === 'win32' && !msvcStlAsanIsInstalled()
if (degraded) {
  process.stderr.write(
    'note: MSVC stl_asan.lib (x64) is not installed, so std::string/std::vector container-overflow ' +
      'annotations are off for this run. Heap, stack and UB checking are unaffected. ' +
      'Add Microsoft.VisualStudio.Component.VC.ASAN to restore them.\n'
  )
}

/** Extra compiler arguments a sanitized build needs on this machine, in order. */
export const sanitizerArguments = degraded ? ['-D_DISABLE_STL_ANNOTATION'] : []

/**
 * The environment a sanitized binary must run under. On Windows the sanitizer
 * runtime is a DLL beside clang rather than something the binary carries, so
 * the loader has to be able to find it.
 */
export const sanitizerEnvironment = () => {
  if (process.platform !== 'win32') return process.env
  const runtime = clangRuntimeDirectory()
  return runtime ? { ...process.env, PATH: `${process.env['PATH'] ?? ''}${delimiter}${runtime}` } : process.env
}
