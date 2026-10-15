// The POSIX shell the release lanes run shell scripts and npm scripts in.
//
// The siblings' npm scripts and core's native tests are POSIX shell: `for f in
// $(git ls-files ...)`, `find | xargs`, `bash run-*.sh`. On Linux and macOS
// that is bash on PATH. On Windows, `bash` on PATH is usually System32's
// bash.exe -- WSL's launcher, which runs the script inside a Linux
// distribution against Linux binaries, not on this host at all -- and npm runs
// scripts in cmd.exe. Git for Windows ships the bash every Windows checkout of
// this stack already has; it is found from the git on PATH or its standard
// install directory, and GEA_BASH overrides both.
//
// On Windows, importing this module also puts that bash's directory first on
// this process's PATH, so a test that spawns `bash` by name gets the same one.
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

const gitBash = () => {
  if (process.env.GEA_BASH) return process.env.GEA_BASH
  const roots = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((directory) => directory && existsSync(join(directory, 'git.exe')))
    // git.exe sits in <Git>\cmd, <Git>\bin or <Git>\mingw64\bin.
    .flatMap((directory) => [dirname(directory), dirname(dirname(directory))])
  for (const programs of [process.env.ProgramFiles, process.env['ProgramW6432'], 'C:\\Program Files'].filter(Boolean))
    roots.push(join(programs, 'Git'))
  // bin\bash.exe, not usr\bin\bash.exe: the launcher puts Git's /usr/bin tools on PATH.
  const bash = roots.map((root) => join(root, 'bin', 'bash.exe')).find(existsSync)
  if (!bash) throw new Error('release suite: no Git for Windows bash found; install Git for Windows or set GEA_BASH to its bin\\bash.exe')
  return bash
}

/** The bash that runs this host's POSIX shell scripts. */
export const posixShell = process.platform === 'win32' ? gitBash() : 'bash'

if (process.platform === 'win32') {
  const directory = dirname(posixShell)
  const rest = (process.env.PATH ?? '').split(delimiter).filter((entry) => entry && entry.toLowerCase() !== directory.toLowerCase())
  process.env.PATH = [directory, ...rest].join(delimiter)
}
