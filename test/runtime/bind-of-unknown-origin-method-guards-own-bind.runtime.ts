// An HTTP framework's `SmartRouter.match` binds the winning router's method:
//
//   this.match = router.match.bind(router)
//
// `router` is a `Router<T>` union, so the bound Function object has no single
// known origin, and a program that writes `target[key] = value` through `any`
// anywhere could, in principle, have given that object an own `bind`. The
// builtin is still the answer unless that one object carries such a write --
// a run-time fact, checked on the object, with the program's own `bind` the
// cold fallback.
interface Greeter {
  greet(name: string): string
}

class Polite implements Greeter {
  constructor(readonly prefix: string) {}
  greet(name: string): string {
    return `${this.prefix} ${name}`
  }
}

class Blunt implements Greeter {
  greet(name: string): string {
    return `hey ${name}`
  }
}

const poke = (target: any, key: string, value: unknown): void => {
  target[key] = value
}

const pick = (index: number): Greeter => (index === 0 ? new Polite('dear') : new Blunt())

const polite = pick(0)
const blunt = pick(1)
const greetPolitely = polite.greet.bind(polite)
const greetBluntly = blunt.greet.bind(blunt)

//! expect: dear ada hey bob
console.log(`${greetPolitely('ada')} ${greetBluntly('bob')}`)

poke(blunt.greet, 'bind', () => (name: string) => `shadowed ${name}`)
const again = blunt.greet.bind(blunt)
const stillPolite = polite.greet.bind(polite)

//! expect: shadowed cy dear di
console.log(`${again('cy')} ${stillPolite('di')}`)
