class Message {
  text: string = 'start'

  append(value: string): void {
    this.text += value
  }

  appendMany(first: string, second: string): void {
    this.text += '/' + first + ':' + second
  }

  duplicate(): void {
    this.text += this.text
  }

  duplicateMany(): void {
    this.text += this.text + this.text
  }

  mutate(): string {
    this.text = 'changed'
    return '/tail'
  }

  appendEffect(): void {
    this.text += this.mutate()
  }

  appendExternalEffect(value: string): void {
    this.text += '/' + externalEffect(value) + '!'
  }

  appendValue(value: string): string {
    return (this.text += value)
  }
}

function externalEffect(value: string): string {
  return value.toUpperCase()
}

const message = new Message()
message.append('/one')
message.appendMany('two', 'three')
message.appendExternalEffect('four')
message.duplicate()
message.duplicateMany()
console.log(message.text)
message.appendEffect()
console.log(message.text)
console.log(message.appendValue('/result'))
console.log(message.text)

class Accessed {
  stored: string = 'before'
  reads: number = 0
  writes: number = 0
  get text(): string {
    this.reads++
    return this.stored
  }
  set text(value: string) {
    this.writes++
    this.stored = value
  }
  append(value: string): void {
    this.text += value
  }
}

const accessed = new Accessed()
accessed.append('/after')
console.log(accessed.stored, accessed.reads, accessed.writes)

let receiverCalls = 0
function receiver(): Message {
  receiverCalls++
  return message
}
receiver().text += '/once'
console.log(message.text, receiverCalls)

const growing = new Message()
for (let i = 0; i < 2000; i++) growing.append('x')
console.log(growing.text.length)

const copied = growing.text
growing.append('/suffix')
console.log(copied.length, growing.text.length)

function chain(a: string, b: string, c: string): string {
  return '[' + a + ':' + b + ':' + c + ']'
}
console.log(chain('abcdefghijklmnopqrstuvwxyz0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', '0123456789abcdefghijklmnopqrstuvwxyz'))
console.log(chain('a\0b', 'é', '😀') === '[a\0b:é:😀]')
console.log('sum=' + (2 + 3) + ';' + 4 + 5)
let changing = 'original'
function change(): string {
  changing = 'changed'
  return '/effect'
}
console.log(changing + change() + changing)
console.log(`${changing}:${change()}:${changing}`)

// A loop may revisit a consumer without refreshing its source. Other loops
// produce a fresh string before the branch into each consuming block.
function keepText(value: string): string {
  return value
}
const repeatedText = 'a long string that must remain intact across loop iterations'
let repeatedOutput = ''
for (let index = 0; index < 3; index++) repeatedOutput += keepText(repeatedText)
console.log(repeatedOutput)
let refreshedOutput = ''
for (let index = 0; index < 3; index++) {
  const fresh = keepText(repeatedText + index)
  if (index >= 0) refreshedOutput += keepText(fresh)
}
console.log(refreshedOutput)
