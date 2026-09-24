import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

// The one answer to "which C++ compiler do the tests and scripts run". Every
// build step that spawned its own `'clang++'` answered it separately, so
// setting `CXX` fixed some steps and left the rest failing with ENOENT.

const onPath = (name) => {
  for (const directory of (process.env['PATH'] ?? '').split(delimiter)) {
    if (directory === '') continue
    const candidate = join(directory, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

/**
 * The newest Visual Studio installation that ships clang, or `null`.
 *
 * Visual Studio's LLVM component is the clang a Windows machine usually has,
 * and it is not put on `PATH` outside a developer prompt. `vswhere` is how
 * Microsoft documents finding an installation; its own location is fixed.
 */
export const visualStudioWithClang = () => {
  if (process.platform !== 'win32') return null
  const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (!existsSync(vswhere)) return null
  const found = spawnSync(
    vswhere,
    ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Llvm.Clang', '-property', 'installationPath'],
    { encoding: 'utf8' }
  )
  const path = found.status === 0 ? found.stdout.trim().split(/\r?\n/)[0] : ''
  return path ? path : null
}

const visualStudioClang = () => {
  const installation = visualStudioWithClang()
  if (installation === null) return null
  const host = process.arch === 'arm64' ? 'ARM64' : 'x64'
  const clang = join(installation, 'VC', 'Tools', 'Llvm', host, 'bin', 'clang++.exe')
  return existsSync(clang) ? clang : null
}

/**
 * `CXX` when set; otherwise `clang++` from `PATH`; on Windows only, when
 * `PATH` has none, the clang inside the newest Visual Studio. The bare name is
 * the last resort so a missing compiler still fails with the name people know.
 */
export const cxx = process.env['CXX'] || (process.platform === 'win32' && !onPath('clang++.exe') ? visualStudioClang() : null) || 'clang++'
