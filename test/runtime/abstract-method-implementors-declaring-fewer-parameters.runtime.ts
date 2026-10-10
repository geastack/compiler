// An abstract method declares an optional trailing parameter its implementors
// leave out (a database client's auth workflow `execute(connection, credentials, response?)`
// implemented as execute(connection, credentials)); calls through the interface
// and the abstract base pass every argument, and a call inside the base passes two.
interface Credentials {
  readonly source: string
}

interface Workflow {
  execute(connection: string, credentials: Credentials, response?: { done: boolean }): Promise<void>
  reauthenticate(connection: string, credentials: Credentials): Promise<void>
}

const log: string[] = []

abstract class CallbackWorkflow implements Workflow {
  async reauthenticate(connection: string, credentials: Credentials): Promise<void> {
    log.push(`reauth ${connection}`)
    await this.execute(connection, credentials)
  }
  abstract execute(connection: string, credentials: Credentials, response?: { done: boolean }): Promise<void>
}

class AutomatedWorkflow extends CallbackWorkflow {
  async execute(connection: string, credentials: Credentials): Promise<void> {
    log.push(`automated ${connection} ${credentials.source}`)
  }
}

class HumanWorkflow extends CallbackWorkflow {
  async execute(connection: string, credentials: Credentials): Promise<void> {
    log.push(`human ${connection} ${credentials.source}`)
  }
}

class Provider {
  constructor(private readonly workflow: Workflow) {}
  async auth(connection: string, reauthenticating: boolean, response?: { done: boolean }): Promise<void> {
    const credentials: Credentials = { source: '$external' }
    if (reauthenticating) await this.workflow.reauthenticate(connection, credentials)
    else await this.workflow.execute(connection, credentials, response)
  }
}

const main = async (): Promise<void> => {
  await new Provider(new AutomatedWorkflow()).auth('c1', false, { done: false })
  await new Provider(new HumanWorkflow()).auth('c2', true)
  console.log(log.join(' | '))
}
void main()
//! expect: automated c1 $external | reauth c2 | human c2 $external
export {}
