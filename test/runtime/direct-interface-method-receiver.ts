//! expect: route=/todos

interface Router {
  route(path: string): string
}

class PatternRouter implements Router {
  prefix = 'route='

  route(path: string): string {
    return `${this.prefix}${path}`
  }
}

class Application {
  router: Router = new PatternRouter()

  resolve(path: string): string {
    return this.router.route(path)
  }
}

console.log(new Application().resolve('/todos'))
