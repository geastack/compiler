// A database client's executeOperation: `catch (error) { return operation.handleError(error) }`
// where `handleError(error: ServiceError)` only rethrows (or rethrows anything
// that is not its own subclass). The caught value is whatever was thrown -- a
// TypeError here -- and it must reach the handler and propagate out of the
// async function as a rejection, as in JS, not abort on the parameter's type.
class DriverError extends Error {
  code = 7
}
class ServerError extends DriverError {}

class Operation {
  handleError(error: DriverError): number {
    throw error
  }
}
class DropOperation extends Operation {
  override handleError(error: DriverError): number {
    if (!(error instanceof ServerError)) throw error
    return error.code
  }
}

async function execute(operation: Operation, thrown: unknown): Promise<number> {
  try {
    throw thrown
  } catch (error: any) {
    return operation.handleError(error)
  }
}

const report = async (label: string, operation: Operation, thrown: unknown): Promise<void> => {
  try {
    console.log(label, 'resolved', await execute(operation, thrown))
  } catch (error) {
    console.log(label, 'rejected', error instanceof TypeError, error instanceof DriverError, (error as Error).message)
  }
}

await report('base-type', new Operation(), new TypeError('boom'))
await report('drop-type', new DropOperation(), new TypeError('bang'))
await report('drop-server', new DropOperation(), new ServerError('gone'))
await report('base-driver', new Operation(), new DriverError('kept'))

//! expect: base-type rejected true false boom
//! expect: drop-type rejected true false bang
//! expect: drop-server resolved 7
//! expect: base-driver rejected false true kept
//! emitted-has: unboxCaughtClassRef
