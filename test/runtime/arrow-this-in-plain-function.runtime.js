//! dynamic-fallback
//! expect: b start
//! expect: start
//! expect: s:3000 true
// avvio's `this._readyQ.drain = () => { this.emit('start') }` inside the
// constructor function `Boot`, and fastify's `listen`, whose arrow assigns
// through `this` and which is only ever called as the instance's method: an
// arrow reads the receiver of the function it sits in, and that receiver is
// the object the call ran on -- never a copy rebuilt into another layout.
function Boot(name) {
  this.name = name
  this.queue = { drain: () => 'idle' }
  this.queue.drain = () => this.emit('start')
}
Boot.prototype.emit = function (event) {
  console.log(this.name, event)
  return event
}
const boot = new Boot('b')
console.log(boot.queue.drain())
function listen(port) {
  const onAborted = () => {
    this.aborted = true
    return this.name + ':' + port
  }
  return onAborted()
}
const server = { name: 's', aborted: false, listen }
console.log(server.listen(3000), server.aborted)
