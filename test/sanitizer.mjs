import { existsSync, readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'

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
const directoriesUnder = (root) => {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
  } catch {
    return []
  }
}

const msvcStlAsanIsInstalled = () => {
  const roots = [process.env['ProgramFiles(x86)'], process.env['ProgramFiles']].filter(Boolean)
  for (const root of roots)
    for (const edition of directoriesUnder(join(root, 'Microsoft Visual Studio')))
      for (const product of directoriesUnder(edition))
        for (const toolset of directoriesUnder(join(product, 'VC', 'Tools', 'MSVC')))
          if (existsSync(join(toolset, 'lib', 'x64', 'stl_asan.lib'))) return true
  return false
}

/** The directory holding clang's own sanitizer runtime, which the built binary loads at run time. */
const clangRuntimeDirectory = () => {
  for (const root of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter(Boolean))
    for (const version of directoriesUnder(join(root, 'LLVM', 'lib', 'clang'))) {
      const windows = join(version, 'lib', 'windows')
      if (existsSync(join(windows, 'clang_rt.asan_dynamic-x86_64.dll'))) return windows
    }
  return null
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
