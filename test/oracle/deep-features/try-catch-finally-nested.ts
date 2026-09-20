//! oracle: node
export function main(): string {
  const log: string[] = []
  try {
    log.push('outer-try')
    try {
      log.push('inner-try')
      throw new Error('inner')
    } catch (e) {
      log.push('inner-catch:' + (e as Error).message)
      throw new Error('rethrow')
    } finally {
      log.push('inner-finally')
    }
  } catch (e) {
    log.push('outer-catch:' + (e as Error).message)
  } finally {
    log.push('outer-finally')
  }
  return log.join('|')
}
console.log(main())
