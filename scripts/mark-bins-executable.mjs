import { chmod, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

// `tsc` writes 0644, so a freshly built `dist/cli.js` is not executable. A
// registry install hides that -- npm's bin-links chmods the target itself --
// but a linked checkout (`npm link`, a `file:` dependency, the `npx` cache
// symlinking straight at this tree) shares the file, and the shell reports
// `Permission denied` on the shebang. Restore the bit at build time so the
// linked path works the same as an installed one.
const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

for (const [name, relative] of Object.entries(manifest.bin ?? {})) {
  const target = resolve(root, relative)
  const mode = (await stat(target)).mode & 0o777
  if (mode === 0o755) continue
  await chmod(target, 0o755)
  process.stdout.write(`Bin: ${name} -> ${relative} marked executable (was ${mode.toString(8)})\n`)
}
