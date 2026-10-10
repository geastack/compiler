// A record handed to a private method whose parameter is a union of two
// option records that it fits equally well: a database client's `Server.command` passes
// its `ServerCommandOptions` to `decorateCommandError(..., options:
// CommandOptions | GetMoreOptions | undefined, ...)`. Neither arm declares
// every key the other does, so no arm is the record's home; viewing it into
// either one rebuilds a copy that drops the other arm's keys (and every write
// through the parameter). The one caller supplies one record, and the method
// sees that record itself.
class Session {
  id: string
  dirty = false
  constructor(id: string) {
    this.id = id
  }
}
interface BaseOptions {
  session?: Session
  raw?: boolean
}
interface CommandOptions extends BaseOptions {
  directConnection?: boolean
  omitMaxTimeMS?: boolean
}
interface GetMoreOptions {
  session?: Session
  batchSize?: number
  comment?: string
}
type ServerCommandOptions = Omit<CommandOptions, 'raw'> & { timeoutMS: number; returnFieldSelector?: Record<string, number> | null }

class Server {
  seen: string[] = []
  private decorate(label: string, options: CommandOptions | GetMoreOptions | undefined): string {
    const session = options?.session
    if (session) session.dirty = true
    const keys =
      options === undefined
        ? 'none'
        : `${'session' in options},${'directConnection' in options},${'omitMaxTimeMS' in options},${'batchSize' in options}`
    return `${label}:${session ? session.id : 'no-session'}:${keys}:${options !== undefined && 'timeoutMS' in options}`
  }
  run(session: Session | undefined): string {
    const options: ServerCommandOptions = { timeoutMS: 5 }
    if (session) options.session = session
    options.directConnection = true
    this.seen.push(this.decorate('first', options))
    options.omitMaxTimeMS = true
    return this.decorate('second', options)
  }
}

const server = new Server()
const session = new Session('s1')
console.log(server.run(session), session.dirty)
console.log(server.run(undefined))
console.log(server.seen.join(' '))
//! expect: second:s1:true,true,true,false:true true
//! expect: second:no-session:false,true,true,false:true
//! expect: first:s1:true,true,false,false:true first:no-session:false,true,false,false:true
