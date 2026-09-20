export {}

// Every `var` here is in the outer CommonJS wrapper's VariableEnvironment and
// therefore reuses the corresponding parameter cell.
var require
var exports
exports.initial = true

var { next: exports } = { next: { fromObjectPattern: true } }
var [module] = [{ exports: { fromArrayPattern: true } }]

for (var exports of [{ fromForOf: true }]) break
for (var module in { moduleKey: true }) break

// A nested function's var is intentionally a distinct local binding.
function nested() {
  var exports = { nested: true }
  return exports
}

module.exports = { exports, module, nested: nested(), loaded: require('./node_modules/conditional-choice/require') }
