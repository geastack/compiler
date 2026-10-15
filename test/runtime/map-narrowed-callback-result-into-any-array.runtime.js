// `Promise.all(files.map((f) => this.bank.load(f)))` and `const jobs =
// passes.map((m) => renderer.compileAsync(...))`, from a JavaScript game: the
// closure reads an untyped parameter, so the checker types its result `any`
// and the call's result `any[]`. The parameter is narrowed from its call
// sites, and the closure then returns a typed promise (an optional one where
// `load` answers a `Map.get`). `map` mints its array of `any`, so each
// result is boxed into it as it is stored.
//! emitted-has: auto __gea_mapped

export {}

class KotoSample {
  /** @param {number} n */
  constructor(n) {
    this.n = n
  }
}

class Bank {
  constructor() {
    /** @type {Map<string, Promise<KotoSample>>} */
    this.pending = new Map()
  }
  /** @param {string} file */
  load(file) {
    if (!this.pending.has(file)) this.pending.set(file, Promise.resolve(new KotoSample(file.length)))
    return this.pending.get(file)
  }
  /** @param {number} n */
  compile(n) {
    return Promise.resolve(new KotoSample(n * 10))
  }
  /** @param {number} n */
  size(n) {
    return n * 2
  }
}

class Score {
  constructor(sound) {
    this.bank = sound.bank
    this.ready = false
  }
  /** @param {any} index */
  init(index) {
    const files = [...index.koto, index.extra]
    return Promise.all(files.map((f) => this.bank.load(f))).then((all) => {
      this.ready = true
      return all.map((t) => t.n).join(',')
    })
  }
}

async function warm(bank) {
  const passes = [1, 2]
  const jobs = passes.map((m) => bank.compile(m))
  const done = await Promise.all(jobs)
  const sizes = passes.map((m) => bank.size(m))
  return done.map((t) => t.n).join(',') + ' ' + sizes.join(',')
}

const bank = new Bank()
const score = new Score({ bank })
//! expect: loaded:1,2,3 ready:true
//! expect: warmed:10,20 2,4
score
  .init(JSON.parse('{"koto":["a","bb"],"extra":"ccc"}'))
  .then((text) => console.log('loaded:' + text + ' ready:' + score.ready))
  .then(() => warm(bank))
  .then((text) => console.log('warmed:' + text))
