class Item {
  value = 8
  read(increment: number): number {
    return this.value + increment
  }
}

class Holder {
  item: Item | undefined
  constructor(item: Item | undefined) {
    this.item = item
  }
}

let effects = 0
function argument(): number {
  effects += 1
  return 2
}

function guarded(holder: Holder | undefined): number {
  return holder?.item?.read(argument()) ?? -1
}

function asserted(holder: Holder | undefined): string {
  try {
    return String(holder?.item!.value)
  } catch {
    return 'threw'
  }
}

function grouped(holder: Holder | undefined): string {
  try {
    return String((holder?.item)!.value)
  } catch {
    return 'threw'
  }
}

console.log(guarded(undefined), guarded(new Holder(undefined)), guarded(new Holder(new Item())), effects)
console.log(asserted(undefined), asserted(new Holder(undefined)), asserted(new Holder(new Item())))
console.log(grouped(undefined), grouped(new Holder(undefined)), grouped(new Holder(new Item())))
