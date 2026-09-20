interface OptionalFrameResult {
  framePayload: number
}

let optionalFrameCalls = 0
function optionalFrame(value?: boolean): OptionalFrameResult {
  optionalFrameCalls++
  return { framePayload: value ? 42 : 17 }
}

console.log(optionalFrame().framePayload, optionalFrame(true).framePayload, optionalFrameCalls)
