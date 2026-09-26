//! dynamic-fallback
//! expect: 3 3 3
//! expect: rho,alpha,beta
//! expect: ALPHA,RHO,BETA
//! expect: alpha5,rho3,beta4
// Fields initialized `[]` declare `any[]`, which states nothing about the
// elements; the pushes do. An untyped comparator takes each class element
// boxed, and reads its fields off the box. find-my-way's router node.
'use strict'
class Param { constructor (name) { this.name = name; this.isRegex = name.startsWith('r') } }
class Store {
  constructor () {
    this.children = []
    this.labels = []
    this.records = []
  }
  add (name) {
    const child = new Param(name)
    this.children.push(child)
    this.children.sort((a, b) => (a.isRegex === b.isRegex ? 0 : a.isRegex ? -1 : 1))
    this.labels.push(name.toUpperCase())
    this.records.push({ name, length: name.length })
    return child
  }
}
const s = new Store()
s.add('alpha'); s.add('rho'); s.add('beta')
console.log(s.children.length, s.labels.length, s.records.length)
console.log(s.children.map((c) => c.name).join(','))
console.log(s.labels.join(','))
console.log(s.records.map((r) => r.name + r.length).join(','))
