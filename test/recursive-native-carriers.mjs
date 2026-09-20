import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const sourceLoader =
  'data:text/javascript,export async function resolve(specifier,context,nextResolve){if(specifier.endsWith(".js")&&context.parentURL?.endsWith(".ts")){const candidate=new URL(specifier,context.parentURL);candidate.pathname=candidate.pathname.slice(0,-3)+".ts";return {url:candidate.href,shortCircuit:true}}return nextResolve(specifier,context)}'
const tested = spawnSync(
  process.execPath,
  ['--experimental-loader', sourceLoader, '--test', 'src/representation/recursive-native-carriers.test.ts'],
  { cwd: root, stdio: 'inherit' }
)

if (tested.status !== 0 || tested.error) {
  if (tested.error) process.stderr.write(`${tested.error}\n`)
  process.exit(1)
}
