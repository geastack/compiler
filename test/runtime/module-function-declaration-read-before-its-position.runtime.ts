class Registry {
  routes: string[] = []
  add(route: string): void {
    this.routes.push(route)
  }
}

async function create(definition: (registry: Registry) => void): Promise<Registry> {
  const registry = new Registry()
  definition(registry)
  return registry
}

const registry = await create(defineRoutes)
console.log(registry.routes.join(','))
console.log('listening')

function defineRoutes(registry: Registry): void {
  registry.add('GET /')
  registry.add('GET /json')
}

//! expect: GET /,GET /json
//! expect: listening
