// @ts-nocheck
// three's `Node._getChildren()` states `@returns {Array<Object>}` over the
// array of child records it builds. The tag states the container and nothing
// about the element, so the return carries the array the body built, not a
// boxed twin of it: the caller iterates the very same records.
class Child {
  constructor(n) {
    this.n = n
  }
}

class Parent {
  constructor() {
    this.a = new Child(1)
    this.b = new Child(2)
  }

  /**
   * @returns {Array<Object>} An array of objects describing the child nodes.
   */
  children() {
    const children = []
    children.push({ property: 'a', childNode: this.a })
    children.push({ property: 'b', index: 0, childNode: this.b })
    return children
  }

  describe() {
    const parts = []
    for (const { property, childNode } of this.children()) parts.push(`${property}=${childNode.n}`)
    return parts.join(',')
  }
}

console.log(new Parent().describe())
//! expect: a=1,b=2
