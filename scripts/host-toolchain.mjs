// The host C++ toolchain every native check drives, found the same way on
// every host.
//
// The checks spawn `clang++` by name. On Linux and macOS it is on PATH. The
// Windows LLVM installer does not put itself there by default, and a test
// suite has no business requiring a machine-wide PATH change. So importing
// this module puts LLVM's bin directory on THIS process's PATH, which every
// check, compiler and test binary it spawns inherits: LLVM_ROOT when it is
// set, else the clang++ already on PATH, else the standard install directory.
//
// It also adds the directory holding clang's sanitizer runtime DLLs. A Windows
// binary built with -fsanitize=address loads clang_rt.asan_dynamic at start,
// and that DLL ships beside clang's resource directory, not in bin/.
import { existsSync, readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'

const windows = process.platform === 'win32'

const directoriesUnder = (root) => {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
  } catch {
    return []
  }
}

const pathDirectories = () => (process.env.PATH ?? '').split(delimiter).filter(Boolean)

/** The LLVM installation root (the directory holding bin/clang++), or null where none is found. */
export const llvmRoot = () => {
  const clang = windows ? 'clang++.exe' : 'clang++'
  if (process.env.LLVM_ROOT && existsSync(join(process.env.LLVM_ROOT, 'bin', clang))) return process.env.LLVM_ROOT
  const onPath = pathDirectories().find((directory) => existsSync(join(directory, clang)))
  if (onPath) return join(onPath, '..')
  if (!windows) return null
  for (const programs of [process.env.ProgramFiles, process.env['ProgramW6432'], 'C:\\Program Files'].filter(Boolean)) {
    const root = join(programs, 'LLVM')
    if (existsSync(join(root, 'bin', clang))) return root
  }
  return null
}

/** The directory holding clang's Windows sanitizer runtime DLLs, or null. */
export const clangSanitizerRuntimeDirectory = (root = llvmRoot()) => {
  if (!windows || !root) return null
  for (const version of directoriesUnder(join(root, 'lib', 'clang'))) {
    const directory = join(version, 'lib', 'windows')
    if (existsSync(join(directory, 'clang_rt.asan_dynamic-x86_64.dll'))) return directory
  }
  return null
}

const msvcStlAsanIsInstalled = () => {
  for (const root of [process.env['ProgramFiles(x86)'], process.env['ProgramFiles']].filter(Boolean))
    for (const edition of directoriesUnder(join(root, 'Microsoft Visual Studio')))
      for (const product of directoriesUnder(edition))
        for (const toolset of directoriesUnder(join(product, 'VC', 'Tools', 'MSVC')))
          if (existsSync(join(toolset, 'lib', 'x64', 'stl_asan.lib'))) return true
  return false
}

/**
 * Whether this is a Windows host whose MSVC STL cannot link a sanitized build.
 *
 * MSVC's STL annotates `std::string` and `std::vector` buffers for
 * AddressSanitizer and asks the linker for `stl_asan.lib` whenever it is
 * compiled under one. That library comes from Visual Studio's optional "C++
 * AddressSanitizer" component, not from LLVM; without it every -fsanitize=address
 * link fails before a test runs -- the compiler's checks, core's native tests
 * and parallel's sanitizer builds alike, each spelling its own clang line.
 *
 * `_DISABLE_STL_ANNOTATION` turns off exactly those container annotations and
 * nothing else: heap, stack, use-after-free and the whole of UBSan are
 * unaffected. What it costs is detecting an overflow that stays INSIDE a
 * string's or vector's own allocation. So it is applied only where the library
 * is absent, it says so, and it reaches every clang this process starts through
 * the driver's CCC_OVERRIDE_OPTIONS (`#` keeps the edit silent; `+` appends).
 * Install the component to get the annotations back:
 *
 *   "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\setup.exe" modify \
 *     --installPath "<VS install>" --add Microsoft.VisualStudio.Component.VC.ASAN
 */
export const msvcStlAsanMissing = windows && !msvcStlAsanIsInstalled()

if (msvcStlAsanMissing && !/_DISABLE_STL_ANNOTATION/.test(process.env.CCC_OVERRIDE_OPTIONS ?? '')) {
  process.stderr.write(
    'note: MSVC stl_asan.lib (x64) is not installed, so std::string/std::vector container-overflow ' +
      'annotations are off for this run. Heap, stack and UB checking are unaffected. ' +
      'Add Microsoft.VisualStudio.Component.VC.ASAN to restore them.\n'
  )
  const edits = (process.env.CCC_OVERRIDE_OPTIONS ?? '').replace(/^#\s*/, '')
  process.env.CCC_OVERRIDE_OPTIONS = `# ${edits} +-D_DISABLE_STL_ANNOTATION`.replace(/\s+/g, ' ')
}

/**
 * The directory holding GNU make on Windows, or null. ESP-IDF builds run
 * libvpx's own configure and make (targets' gea_vpx component), and neither
 * ESP-IDF nor Git for Windows ships make. winget installs it per user and
 * links it into WinGet\Links, which a shell started before the install does
 * not have on PATH yet: PATH first, then those two winget locations.
 */
export const gnuMakeDirectory = () => {
  if (!windows) return null
  const onPath = pathDirectories().find((directory) => ['make.exe', 'gmake.exe'].some((name) => existsSync(join(directory, name))))
  if (onPath) return onPath
  const winget = join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local'), 'Microsoft', 'WinGet')
  const candidates = [join(winget, 'Links'), ...directoriesUnder(join(winget, 'Packages')).map((directory) => join(directory, 'bin'))]
  return candidates.find((directory) => existsSync(join(directory, 'make.exe'))) ?? null
}

if (windows) {
  const root = llvmRoot()
  const wanted = [...(root ? [join(root, 'bin'), clangSanitizerRuntimeDirectory(root)] : []), gnuMakeDirectory()].filter(Boolean)
  const present = new Set(pathDirectories().map((directory) => directory.toLowerCase()))
  const missing = wanted.filter((directory) => !present.has(directory.toLowerCase()))
  // process.env is case-insensitive on Windows, so this is the one `Path` entry
  // children inherit, not a second variable beside it.
  if (missing.length) process.env.PATH = [...missing, ...pathDirectories()].join(delimiter)
}
