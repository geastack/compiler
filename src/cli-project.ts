import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { discoverNodeProject } from './semantics/node-project.js'
import { ensureDependencies } from './project-preparation.js'

export const isNodeProjectArguments = (argv: readonly string[]): boolean => {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--translation-units') {
      const value = argv[index + 1]
      if (value !== 'single' && value !== 'per-file' && value !== 'balanced') return false
      index += 1
    } else if (!['--dynamic-fallback', '--debug', '--emit-only', '--verbose'].includes(argument ?? '')) {
      return false
    }
  }
  return true
}

export const runNodeProject = async (argv: readonly string[]): Promise<number> => {
  if (!isNodeProjectArguments(argv)) throw new Error(`Unknown or invalid project option: ${argv.join(' ')}`)
  let directory = process.cwd()
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory)
    if (parent === directory) throw new Error('No package.json found. Run geatsc inside a Node project.')
    directory = parent
  }
  ensureDependencies(directory)
  const project = discoverNodeProject(directory)
  const packageRequire = createRequire(import.meta.url)
  const driver = packageRequire.resolve('@geastack/node-compat/build')
  for (const entry of project.entries) {
    if (!/^[\w.-]+$/.test(entry.name) || entry.name === '.' || entry.name === '..')
      throw new Error(`Invalid executable name: ${entry.name}`)
    const dist = join(project.root, 'dist')
    const out = join(dist, '.geatsc', entry.name)
    mkdirSync(out, { recursive: true })
    const executable = join(dist, process.platform === 'win32' ? `${entry.name}.exe` : entry.name)
    console.error(`[geatsc] ${entry.file} -> ${executable}`)
    const args = [driver, entry.file, '--out', out, '--exe', executable, '--report', join(out, 'report.json'), ...argv]
    if (project.projectFile) args.push('--source-project', project.projectFile)
    const status = await new Promise<number>((resolveStatus, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: project.root,
        stdio: 'inherit',
        env: process.env
      })
      child.on('error', reject)
      child.on('exit', (code) => resolveStatus(code ?? 1))
    })
    if (status !== 0) return status
  }
  return 0
}
