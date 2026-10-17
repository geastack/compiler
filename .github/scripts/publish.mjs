// Publishes every package listed in RELEASE_PACKAGES whose version is not on
// npm yet, then tags the released commit. Runs on a push to `release`: tests
// pass locally before main is merged there, so nothing here re-runs them.
//
// RELEASE_PACKAGES is a JSON array of { dir, build? } in publish order. `build`
// is a shell command run in `dir` before publishing; without one, a package
// with a build script gets its dependencies installed and `npm run build`.
// Publishing uses npm trusted publishing (OIDC), so no token is involved.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const packages = JSON.parse(process.env.RELEASE_PACKAGES || '[]')
if (!packages.length) throw new Error('RELEASE_PACKAGES lists no packages')

const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' })
const shell = (command, cwd) => run('bash', ['-euo', 'pipefail', '-c', command], cwd)

const published = (name, version) => {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' })
  return result.status === 0 && result.stdout.trim() === version
}

const install = (dir) => {
  if (existsSync(join(dir, 'package-lock.json'))) run('npm', ['ci', '--ignore-scripts'], dir)
  else run('npm', ['install', '--no-package-lock', '--ignore-scripts'], dir)
}

// A single-package repository tags v<version>; a repository with several
// packages tags each one <name>@<version>. Each tag is pushed as soon as its
// package is accepted, so a later failure leaves the earlier releases tagged.
run('git', ['config', 'user.name', 'github-actions[bot]'])
run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
const released = []
for (const { dir, build } of packages) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const id = `${manifest.name}@${manifest.version}`
  if (published(manifest.name, manifest.version)) {
    console.log(`${id} is already on npm`)
    continue
  }
  if (build) shell(build, dir)
  else if (manifest.scripts?.build) {
    install(dir)
    run('npm', ['run', 'build'], dir)
  }
  // Lifecycle scripts stay off: builds ran above, and prepublishOnly hooks
  // would re-run tests that already passed locally.
  run('npm', ['publish', '--access', 'public', '--provenance', '--ignore-scripts'], dir)
  const tag = packages.length === 1 ? `v${manifest.version}` : id
  run('git', ['tag', tag])
  run('git', ['push', 'origin', `refs/tags/${tag}`])
  released.push(tag)
}
console.log(released.length ? `Published and tagged: ${released.join(', ')}` : 'Nothing new to publish')
