// @ts-nocheck
// three's `Bindings._createBindings( bindings )` states `@param
// {Array<BindGroup>}`, a name its file cannot bind, and `NodeFunction`'s
// `inputs` is the same shape. The tag states the container and nothing about
// the element, so every caller's typed array is what the parameter holds: the
// SAME array, which the callee's push and the caller's later reads share.
class Group {
  constructor(id) {
    this.id = id
  }
}

class Bindings {
  constructor() {
    this.total = 0
  }

  /**
   * @param {Array<BindGroup>} groups - The bind groups.
   */
  create(groups) {
    for (const group of groups) this.total += group.id
    groups.push(new Group(groups.length + 1))
  }

  run() {
    const groups = [new Group(1), new Group(2)]
    this.create(groups)
    this.create(groups)
    return `${this.total} ${groups.length} ${groups[3].id}`
  }
}

console.log(new Bindings().run())
//! expect: 9 4 4
