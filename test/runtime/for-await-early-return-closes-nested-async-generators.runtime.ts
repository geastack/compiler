// A database client's `readMany` shape with the early `return`: a source async
// generator (the wire stream) is read by a middle async generator that
// `return`s out of its `for await` once a message is complete, and the
// command path `return`s out of ITS `for await` over the middle one after the
// first response. Each early exit is AsyncIteratorClose: `return()` on the
// generator being walked, awaited, running that generator's `finally` before
// the exiting function goes on. The order of the `finally` lines against the
// consumer's own lines is what node prints.
async function* wire(log: string[]): AsyncGenerator<string> {
  try {
    for (const chunk of ['he', 'llo|', 'wor', 'ld|', 'never']) {
      await null
      log.push(`wire:${chunk}`)
      yield chunk
    }
  } finally {
    log.push('wire:closed')
  }
}

async function* readMany(log: string[]): AsyncGenerator<string> {
  let buffer = ''
  try {
    for await (const chunk of wire(log)) {
      buffer += chunk
      const end = buffer.indexOf('|')
      if (end >= 0) {
        yield buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (buffer.length === 0 && chunk === 'llo|') {
          log.push('readMany:first complete')
        }
      }
    }
  } finally {
    log.push('readMany:closed')
  }
}

async function command(log: string[]): Promise<string> {
  for await (const response of readMany(log)) {
    log.push(`command:${response}`)
    return response
  }
  return 'none'
}

async function main(): Promise<void> {
  const log: string[] = []
  const response = await command(log)
  log.push(`main:${response}`)
  // One line, so the expectation pins the ORDER, not just the presence.
  console.log(log.join(' | '))
}
main()
//! expect: wire:he | wire:llo| | command:hello | wire:closed | readMany:closed | main:hello
