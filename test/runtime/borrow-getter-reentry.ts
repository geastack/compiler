//! expect: before1 after

class Source {
  label = 'before'
  get change(): number {
    this.label = 'after'
    return 1
  }
}

function snapshot(value: string, source: Source): string {
  const suffix = source.change
  return value + suffix
}

const source = new Source()
console.log(snapshot(source.label, source), source.label)
