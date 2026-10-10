// ECMA-262 20.1.1.1: `Object()` with no value is a fresh ordinary object.
// A database client's logger builds its severity table from `const severities =
// Object()` and returns it as a typed record of records.

type Level = 'error' | 'debug'
function severitiesFor(components: string[]): Record<string, Record<Level, boolean>> {
  const severities = Object()
  for (const component of components) {
    severities[component] = {}
    for (const level of ['error', 'debug'] as Level[]) severities[component][level] = level === 'error'
  }
  return severities
}
const table = severitiesFor(['command', 'topology'])
//! expect: command.error=true command.debug=false topology.error=true
console.log(
  'command.error=' + table['command']!.error + ' command.debug=' + table['command']!.debug + ' topology.error=' + table['topology']!.error
)
//! expect: keys=command,topology
console.log('keys=' + Object.keys(table).join(','))
const fresh: Record<string, number> = new Object() as Record<string, number>
fresh['a'] = 1
//! expect: fresh={"a":1}
console.log('fresh=' + JSON.stringify(fresh))
