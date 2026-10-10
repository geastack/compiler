// A structural constructor type with a static factory, unioned with the class
// that satisfies it (a database client's `(responseType ?? ServerResponse).make(bytes)`).
// The union arm carried by its construct ABI still has to answer `make` from
// the class it actually holds -- including a subclass that inherits `make`
// and one that redeclares it -- with `this` bound to that class.

class WireResponse {
  constructor(
    readonly bytes: Uint8Array,
    readonly offset?: number
  ) {}
  kind(): string {
    return 'response'
  }
  static make(bytes: Uint8Array): WireResponse {
    return new this(bytes, 0)
  }
}

class CursorResponse extends WireResponse {
  override kind(): string {
    return 'cursor'
  }
}

class ExplainResponse extends WireResponse {
  override kind(): string {
    return 'explain'
  }
  static override make(bytes: Uint8Array): WireResponse {
    return new ExplainResponse(bytes, bytes.length)
  }
}

type ResponseConstructor = {
  new (bytes: Uint8Array, offset?: number): WireResponse
  make(bytes: Uint8Array): WireResponse
}

function build(bytes: Uint8Array, factory: ResponseConstructor | typeof WireResponse): WireResponse {
  return factory.make(bytes)
}

function read(bytes: Uint8Array, responseType?: ResponseConstructor): string {
  const made = responseType === undefined ? build(bytes, WireResponse) : build(bytes, responseType)
  return `${made.kind()}:${made.offset}:${made.bytes.length}`
}

interface CommandOptions {
  responseType?: ResponseConstructor
}

const bytes = new Uint8Array([1, 2, 3])
const commands: CommandOptions[] = [{}, { responseType: CursorResponse }, { responseType: ExplainResponse }, { responseType: WireResponse }]
for (const options of commands) console.log(read(bytes, options.responseType))

//! expect: response:0:3
//! expect: cursor:0:3
//! expect: explain:3:3
//! expect: response:0:3

export {}
