// A CLASS INSTANCE PASSED WHERE A RECORD OF ONE OVERLOADED METHOD IS DECLARED.
//
// A database client's logger builds its default log sink with
// `createStdioLogger(process.stderr)`, whose parameter is
// `{ write: NodeJS.WriteStream['write'] }` -- a record holding the stream
// class's overloaded `write` method type (node-compat declares
// `NodeJS.WriteStream` as its `process.ts` class) -- and `process.stderr` is an
// instance of that class. The record's `write` must be the
// instance's method bound to the instance: calling it through the record runs
// the class body with `this` the stream, and later writes on the stream are
// seen by the same instance.

type WriteCallback = (error?: Error | null) => void

class Sink {
  private fd_: number
  lines: string[] = []

  constructor(fd: number) {
    this.fd_ = fd
  }

  write(data: string): boolean
  write(data: string, encoding: string): boolean
  write(data: string, encoding: string, callback: WriteCallback): boolean
  write(data: string, encoding: string = 'utf8', callback: WriteCallback = () => {}): boolean {
    this.lines.push(`${this.fd_}:${encoding}:${data}`)
    callback(null)
    return true
  }
}

interface LogWritable {
  write(line: string): Promise<unknown>
}

function createStdioLogger(stream: { write: Sink['write'] }): LogWritable {
  return {
    write: (line: string): Promise<unknown> => {
      return new Promise((resolve, reject) => {
        stream.write(`${line}`, 'utf-8', (error) => {
          if (error) return reject(error)
          resolve(true)
        })
      })
    }
  }
}

const sink = new Sink(2)
const logger = createStdioLogger(sink)
const result = logger.write('first')
sink.write('direct')

const sameWrite = (stream: { write: Sink['write'] }): boolean => stream.write === sink.write
//! expect: same=true
console.log(`same=${sameWrite(sink)}`)

//! expect: lines=2:utf-8:first|2:utf8:direct
console.log(`lines=${sink.lines.join('|')}`)

void result.then((value) => {
  //! expect: resolved=true
  console.log(`resolved=${String(value)}`)
})
