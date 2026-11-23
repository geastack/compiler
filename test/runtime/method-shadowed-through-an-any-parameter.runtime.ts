//! expect: shadowed 5 own
//! expect: named own own
//! expect: element own
//! expect: kept proto
// A write through an `any` receiver lands on whatever object the caller
// boxed into it. When that object is a class instance and the key names one
// of its methods, the write is an own property shadowing the prototype
// method, and a later typed call of the method must see it -- whether the
// key is computed or spelled, and whether the instance entered the `any`
// slot as an argument or as an element of an `any[]`.

class Tag {
  name: unknown = 'tag'
  describe(): string {
    return 'proto'
  }
}
function install(target: any, key: string, value: unknown): void {
  target[key] = value
}
const tag = new Tag()
install(tag, 'name', 5)
install(tag, 'describe', () => 'own')
console.log('shadowed ' + tag.name + ' ' + tag.describe())

class Named {
  describe(): string {
    return 'proto'
  }
}
function replace(target: any): void {
  target.describe = () => 'own'
}
const named = new Named()
replace(named)
const seen: any = named
console.log('named ' + named.describe() + ' ' + seen.describe())

class Element {
  describe(): string {
    return 'proto'
  }
}
function installAll(targets: any[], key: string): void {
  for (const target of targets) target[key] = () => 'own'
}
const element = new Element()
installAll([element], 'describe')
console.log('element ' + element.describe())

// A class no `any` slot ever receives keeps its direct prototype call.
class Kept {
  describe(): string {
    return 'proto'
  }
}
console.log('kept ' + new Kept().describe())
export {}
