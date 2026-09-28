//! expect: [ajv] log 2
// ajv's `getLogger`: the host `console` is returned where `Logger`, an
// interface of three methods, is declared. The record the program reads is
// the host's own methods read as values, each called through the interface.
interface Logger {
  log(...args: unknown[]): unknown
  warn(...args: unknown[]): unknown
  error(...args: unknown[]): unknown
}
const noLogs = { log() {}, warn() {}, error() {} }
function getLogger(logger?: Partial<Logger> | false): Logger {
  if (logger === false) return noLogs
  if (logger === undefined) return console
  if (logger.log && logger.warn && logger.error) return logger as Logger
  throw new Error('logger must implement log, warn and error methods')
}
getLogger(false).log('silent')
getLogger().log('[ajv]', 'log', 2)
