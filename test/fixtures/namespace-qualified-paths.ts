// Every way TypeScript's own compiler reaches a source namespace's members:
// through a namespace import (`ts.Debug.loggingHost = ...` in tsc.ts), by a
// direct import, through a nested namespace (`Debug.log.trace`), read,
// written from another file (`Debug.isDebugging = true` in sys.ts), compound
// assigned, and called. None of these reads `Debug` as a value.
import * as lib from './namespace-qualified-lib'
import { Debug } from './namespace-qualified-lib'

lib.Debug.isDebugging = true
Debug.level += 2
Debug.log.trace('start')
lib.Debug.assert(Debug.level === 2, 'two')
console.log(Debug.isDebugging, Debug.level, lib.Debug.level)
