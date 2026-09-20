// Returning an existing promise from an async body adopts its state and
// converts the fulfillment value into the declared result carrier. Hono's
// request helpers use this exact shape: Promise<string> returned from a body
// declared Promise<string | Response>.

const promisedText = (): Promise<string> => Promise.resolve('ready')

async function widenedPromise(): Promise<string | number> {
  return promisedText()
}

//! expect: promise=ready
console.log('promise=' + (await widenedPromise()))

// Hono's HtmlEscapedString implementation constructs a String wrapper and
// exposes its [[StringData]] through a primitive-string return type.
type EscapedText = string & { readonly isEscaped: true }

const escaped = (value: string): EscapedText => new String(value) as unknown as EscapedText

function primitiveText(): string {
  return escaped('html')
}

//! expect: string=html
console.log('string=' + primitiveText())
