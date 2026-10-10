//! expect: read:timer-5
//! expect: none:true
//! expect: absent:true

// A database client's socket reader: `const timeoutForSocketRead =
// timeoutContext?.timeoutForSocketRead`, where `timeoutForSocketRead` is an
// abstract getter (`Timeout | null`) every TimeoutContext overrides. The read
// dispatches through the family's virtual getter, whose carrier is the
// getter's own; the optional chain publishes `Timeout | null | undefined`, so
// the dispatched result must enter that carrier like any other member read.

class Timeout extends Promise<never> {
  label = ''
}

function makeTimeout(label: string): Timeout {
  const timeout = new Timeout(() => {})
  timeout.label = label
  return timeout
}

abstract class TimeoutContext {
  abstract get timeoutForSocketRead(): Timeout | null
}

class CSOTTimeoutContext extends TimeoutContext {
  timeout = makeTimeout('timer-5')
  get timeoutForSocketRead(): Timeout | null {
    return this.timeout
  }
}

class LegacyTimeoutContext extends TimeoutContext {
  get timeoutForSocketRead(): Timeout | null {
    return null
  }
}

function socketRead(timeoutContext?: TimeoutContext): string {
  const timeoutForSocketRead = timeoutContext?.timeoutForSocketRead
  if (timeoutForSocketRead === undefined) return 'absent'
  if (timeoutForSocketRead === null) return 'none'
  return timeoutForSocketRead.label
}

console.log('read:' + socketRead(new CSOTTimeoutContext()))
console.log('none:' + (socketRead(new LegacyTimeoutContext()) === 'none'))
console.log('absent:' + (socketRead() === 'absent'))
