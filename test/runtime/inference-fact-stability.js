class Configuration {
  constructor() {
    /** @type {Object} */
    this.params = { first: { threshold: 1 }, second: { threshold: 2 } }
  }
}
function first(configuration) {
  return configuration.params.first.threshold
}
function second(configuration) {
  return configuration.params.second.threshold
}
const configuration = new Configuration()
console.log(first(configuration), second(configuration))
