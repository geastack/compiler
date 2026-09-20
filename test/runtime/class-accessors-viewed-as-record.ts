// A CLASS WHOSE MEMBERS ARE GETTERS, HANDED TO A PARAMETER TYPED AS A
// STRUCTURAL RECORD OF THOSE MEMBERS.
//
// `@hono/node-server` reaches this through
// `Pick<IncomingMessage, 'rawHeaders'> & { headers?: IncomingMessage['headers'] }`:
// the argument is the connection object, and every member the parameter names
// is an ACCESSOR on it. A record view rebuilds the target shape field by
// field out of the source's PHYSICAL storage, and a getter-backed member has
// none -- so the read is a call to the getter, exactly as a method-backed
// member is a bound call.
//
// The subclass is here because the real pair is
// `Http2ServerRequest extends IncomingMessage`: a family that inherits the
// accessor without redeclaring it is still closed at that key, and the direct
// getter call remains the right answer for every instance in it.

interface HeadersSource {
  rawHeaders: string[]
  headers?: Record<string, string>
}

class Incoming {
  private lines: string[]
  private parsed: Record<string, string> | undefined = undefined

  constructor(lines: string[]) {
    this.lines = lines
  }

  get rawHeaders(): string[] {
    return this.lines
  }

  get headers(): Record<string, string> {
    if (this.parsed === undefined) {
      const built: Record<string, string> = {}
      for (let index = 0; index + 1 < this.lines.length; index += 2) {
        built[String(this.lines[index]).toLowerCase()] = String(this.lines[index + 1])
      }
      this.parsed = built
    }
    return this.parsed
  }
}

class Http2Incoming extends Incoming {
  readonly authority: string

  constructor(lines: string[], authority: string) {
    super(lines)
    this.authority = authority
  }
}

const describe = (source: HeadersSource): string => {
  const names = source.rawHeaders.filter((_, index) => index % 2 === 0).join(',')
  const headers = source.headers
  return names + '|' + (headers === undefined ? '-' : String(headers['content-type']))
}

//! expect: plain=Content-Type,Accept|text/plain
console.log('plain=' + describe(new Incoming(['Content-Type', 'text/plain', 'Accept', '*/*'])))

//! expect: derived=Content-Type|application/json
console.log('derived=' + describe(new Http2Incoming(['Content-Type', 'application/json'], 'example.test')))
