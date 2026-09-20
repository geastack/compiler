/**
 * A class static spelled as a bare assignment on the class value -- three.js's
 * own idiom (`Object3D.DEFAULT_UP = new Vector3(0, 1, 0)`), which the language
 * admits as an ordinary `[[Set]]` on the constructor and no `static` member
 * declares. Both directions are exercised: the store that fills the storage
 * and a later read of it, so a compile that emits one without the other fails
 * here rather than in a three.js-sized program.
 */
class Axis {
  x: number
  y: number
  constructor(x: number, y: number) {
    this.x = x
    this.y = y
  }
}

class Node3 {
  static DEFAULT_UP: Axis
  static AUTO_UPDATE: boolean
  up: Axis
  constructor() {
    this.up = Node3.DEFAULT_UP
  }
}

Node3.DEFAULT_UP = new Axis(0, 1)
Node3.AUTO_UPDATE = true

const node = new Node3()
console.log(`${node.up.x},${node.up.y},${Node3.AUTO_UPDATE}`)
