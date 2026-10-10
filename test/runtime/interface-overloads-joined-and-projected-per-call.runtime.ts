// An interface method declared as two overloads whose arity and results
// disagree -- a database client's `AuthPluginClient.step(challenge): Promise<string>` beside
// `step(challenge, callback): void` -- held by a value of a class that
// implements only the promise form (the auth plugin package's own client).
// The overloads join into one frame (`host-abi.ts`'s
// `callbackOverloadJoinedAbi`): the widest arity, the callback optional, the
// result `Promise<string> | undefined`. The class's methods are bound into it
// with their own prefix of the arguments, and every call names one overload,
// so it reads the member as that overload's convention -- the result
// projected back to `Promise<string>`, checked.
//! expect: step:a
//! expect: unwrap:b wrapped:unwrap:b
//! expect: 3

type Callback<T> = (error?: Error, result?: T) => void

interface Client {
  step(challenge: string): Promise<string>
  step(challenge: string, callback: Callback<string>): void
  wrap(challenge: string, options: { user: string }): Promise<string>
  wrap(challenge: string, options: { user: string }, callback: Callback<string>): void
  unwrap(challenge: string): Promise<string>
  unwrap(challenge: string, callback: Callback<string>): void
}

let calls = 0

class NativeClient {
  async step(challenge: string): Promise<string> {
    calls++
    return 'step:' + challenge
  }
  async wrap(challenge: string, options?: { user: string }): Promise<string> {
    calls++
    return 'wrapped:' + challenge + (options ? '' : '?')
  }
  async unwrap(challenge: string): Promise<string> {
    calls++
    return 'unwrap:' + challenge
  }
}

async function makeClient(): Promise<Client> {
  return new NativeClient()
}

async function finalize(client: Client, payload: string): Promise<string> {
  const response = await client.unwrap(payload)
  return response + ' ' + (await client.wrap(response || '', { user: 'u' }))
}

async function main(): Promise<void> {
  const client = await makeClient()
  // node prints: step:a
  console.log(await client.step('a'))
  // node prints: unwrap:b wrapped:unwrap:b
  console.log(await finalize(client, 'b'))
  // node prints: 3
  console.log(calls)
}
void main()
