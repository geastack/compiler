//! expect: call own 3
//! expect: value own read
//! expect: keys name,describe
//! expect: deleted proto
//! expect: sub own sub-proto base-proto
//! expect: hot 2000
//! expect: union own plate
//! emitted-has: nativeExpandoPresent
//! emitted-lacks: gea_present_describe
// A method only a write through a dynamic receiver can shadow keeps no slot
// in the instance: the write lands in the instance's expando table, and a
// typed call or read checks that table only when the instance has one. Every
// way the program can observe the shadow still sees it -- a call, a method
// value read, key enumeration and its deletion -- and a
// subclass instance boxed into the same slot is shadowed through its own
// override, and a union arm checks its own instance. Instances nothing wrote
// to keep calling the prototype methods.

class Tag {
  name = 'tag'
  describe(): string {
    return 'proto'
  }
  count(n: number): number {
    return n
  }
}
class Badge extends Tag {
  describe(): string {
    return 'sub-proto'
  }
}

function install(target: any, key: string, value: unknown): void {
  target[key] = value
}
function remove(target: any, key: string): void {
  delete target[key]
}

const tag = new Tag()
install(tag, 'describe', () => 'own')
install(tag, 'count', (n: number) => n + 2)
console.log('call ' + tag.describe() + ' ' + tag.count(1))

const read = tag.describe
console.log('value ' + read() + ' read')

const shown: string[] = []
for (const key of Object.keys(tag)) if (key !== 'count') shown.push(key)
console.log('keys ' + shown.join(','))

const plain = new Tag()

remove(tag, 'describe')
console.log('deleted ' + tag.describe())

const badge = new Badge()
const other = new Badge()
install(badge, 'describe', () => 'own')
const asBase: Tag = other
console.log('sub ' + badge.describe() + ' ' + asBase.describe() + ' ' + new Tag().describe().replace('proto', 'base-proto'))

let total = 0
for (let i = 0; i < 1000; i++) total += plain.count(2)
console.log('hot ' + total)

class Plate {
  describe(): string {
    return 'plate'
  }
}
const shadowedTag = new Tag()
install(shadowedTag, 'describe', () => 'own')
const items: (Tag | Plate)[] = [shadowedTag, new Plate()]
const answers: string[] = []
for (const item of items) answers.push(item.describe())
console.log('union ' + answers.join(' '))
