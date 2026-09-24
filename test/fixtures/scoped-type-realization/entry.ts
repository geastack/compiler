import Node from './vendor/node-lib/src/core/Node.js'
import { Frame } from './vendor/node-lib/src/core/Frame.js'

const frame = new Frame()
const first = new Node(3)
console.log(frame.visit(first), frame.visit(first), frame.visit(new Node(5)))
