class Leaf {
  value = 7
  add(value: number): number {
    return this.value + value
  }
}

class Root {
  leaf = new Leaf()
  values = [11]
  getLeaf(): Leaf {
    return this.leaf
  }
}

let effects = 0
function argument(): number {
  effects += 1
  return 2
}

function index(): number {
  effects += 1
  return 0
}

function run(root: Root | undefined): void {
  console.log(root?.leaf.value ?? -1)
  console.log(root?.leaf.add(argument()) ?? -1)
  console.log(root?.getLeaf().add(argument()) ?? -1)
  console.log(root?.values[index()] ?? -1)
  console.log(effects)
}

run(undefined)
run(new Root())

function nested(root: Root | undefined): number {
  return root?.getLeaf()?.value ?? -1
}
console.log(nested(undefined), nested(new Root()))
