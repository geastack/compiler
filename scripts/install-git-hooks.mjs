// Points this checkout's git at the tracked hooks. Runs on `npm install`; a
// package installed from the registry has no `.git` and is left alone.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

if (existsSync('.git') && existsSync('.githooks')) execFileSync('git', ['config', 'core.hooksPath', '.githooks'])
