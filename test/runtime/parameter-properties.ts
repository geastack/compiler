// `constructor(readonly name: string)` -- a parameter property.
//
// Two declarations written as one: a formal parameter, and an instance member
// the constructor assigns that parameter into. Reading the emitted C++ proves
// the member exists; only running it proves WHEN the store happens, which is
// the whole of what this file is for.
//
// The language's order is: bind every parameter (running each default), then
// `super(...)` if the class has a base, then the stores, then the rest of the
// constructor body. Three separately observable facts, one per section below.

const log: string[] = []
const probe = (label: string, value: number): number => {
  log.push(label)
  return value
}

class Animal {
  constructor(readonly name: string) {}
  speak(): string {
    return this.name + ' makes a sound'
  }
}

//! expect: base=rex/rex makes a sound
const animal = new Animal('rex')
console.log('base=' + animal.name + '/' + animal.speak())

// A derived class: `super(...)` runs the base's own store first, and this
// class's stores land after it. The body statement below reads `this.name`,
// which only the base's store can have written.
class Dog extends Animal {
  private barks = 0
  private greeting = ''
  constructor(
    name: string,
    readonly breed: string
  ) {
    super(name)
    this.greeting = 'hello ' + this.name
  }
  override speak(): string {
    this.barks += 1
    return this.greeting + ' the ' + this.breed + ' (' + this.barks + ')'
  }
}

//! expect: derived=rex/husky
const dog = new Dog('rex', 'husky')
console.log('derived=' + dog.name + '/' + dog.breed)
//! expect: derived-speak=hello rex the husky (1)
console.log('derived-speak=' + dog.speak())

// Every accessibility modifier declares the same member; only the checker
// treats them differently.
class Modifiers {
  constructor(
    public open: string,
    private hidden: string,
    protected shared: string,
    readonly frozen: string
  ) {}
  describe(): string {
    return this.open + this.hidden + this.shared + this.frozen
  }
}
//! expect: modifiers=abcd
console.log('modifiers=' + new Modifiers('a', 'b', 'c', 'd').describe())

// Defaults: the store takes the value the parameter is BOUND to, so a caller
// who passed nothing stores the default. And every default runs before any
// store, which is what the log proves -- `one` and `two` both appear before
// the constructor body's own entry.
class Defaults {
  constructor(
    readonly first: number = probe('one', 1),
    readonly second: number = probe('two', 2)
  ) {
    log.push('body')
  }
}
const defaults = new Defaults()
//! expect: defaults=1/2
console.log('defaults=' + defaults.first + '/' + defaults.second)
//! expect: default-order=one,two,body
console.log('default-order=' + log.join(','))
//! expect: passed=9/2
console.log('passed=' + new Defaults(9).first + '/' + new Defaults(9).second)

// An optional parameter property declares an optional member, and a caller who
// passed nothing stores the absence rather than a zero.
class Optionals {
  constructor(readonly maybe?: string) {}
  show(): string {
    return this.maybe ?? 'absent'
  }
}
//! expect: optional=absent/here
console.log('optional=' + new Optionals().show() + '/' + new Optionals('here').show())

// The store runs before the body, so reassigning the local afterwards changes
// the binding and not the member.
class Reassigns {
  constructor(readonly kept: string) {
    kept = 'changed'
    this.trace = kept
  }
  trace = ''
}
const reassigned = new Reassigns('original')
//! expect: reassigned=original/changed
console.log('reassigned=' + reassigned.kept + '/' + reassigned.trace)
