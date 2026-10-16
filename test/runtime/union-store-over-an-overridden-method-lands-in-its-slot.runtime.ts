// A regular-expression router's `match` runs with `this` typed as any router and ends
// with `this.match = match`: one router class holds `match` in a field, the
// others declare it as a method that some write shadows. Through the union,
// the store lands in each arm's own storage -- the field, or the method's
// override slot -- and a later read through the union answers the slot once it
// is present and the prototype method before.
export {}

interface Router {
  match(path: string): string
}

function tableMatch(this: Router, path: string): string {
  const memo = (p: string): string => `memo:${p}`
  this.match = memo
  return `table:${path}`
}

class TableRouter implements Router {
  match: (path: string) => string = tableMatch
}

class ListRouter implements Router {
  match(path: string): string {
    return `list:${path}`
  }
}

class TreeRouter implements Router {
  match(path: string): string {
    return `tree:${path}`
  }
}

const routers: Router[] = [new TableRouter(), new ListRouter(), new TreeRouter()]
const before = routers.map((router) => router.match('/a')).join(',')
for (const router of routers) tableMatch.call(router, '/x')
const after = routers.map((router) => router.match('/b')).join(',')
console.log(before)
console.log(after)
//! expect: table:/a,list:/a,tree:/a
//! expect: memo:/b,memo:/b,memo:/b
