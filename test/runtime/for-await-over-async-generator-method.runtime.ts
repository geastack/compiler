// A database client's connection sends a command by walking async
// generators: `for await (const response of this.readMany(options))` inside
// `sendWire`, itself an `async *` walked by `sendCommand`, walked by
// `command`. An async generator is its own async iterator, so each loop walks
// the generator the call returned, and `return` inside the loop ends it.
class Connection {
  private readonly replies: string[]

  constructor(replies: string[]) {
    this.replies = replies
  }

  private async *readMany(limit: number): AsyncGenerator<string> {
    for (const reply of this.replies.slice(0, limit)) {
      yield reply
    }
  }

  private async *sendWire(limit: number): AsyncGenerator<string> {
    for await (const response of this.readMany(limit)) {
      yield `wire:${response}`
    }
  }

  async command(limit: number): Promise<string> {
    for await (const document of this.sendWire(limit)) {
      return document
    }
    return 'none'
  }

  async all(limit: number): Promise<string> {
    const seen: string[] = []
    for await (const document of this.sendWire(limit)) seen.push(document)
    return seen.join(',')
  }
}

const connection = new Connection(['ok', 'more', 'last'])
console.log(await connection.command(3), await connection.command(0), await connection.all(2))
//! expect: wire:ok none wire:ok,wire:more
