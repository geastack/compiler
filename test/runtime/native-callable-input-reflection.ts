interface NativeCallbackInput {
  callbackInputValue: number
}

const callableHolder = {
  callback: (input: NativeCallbackInput): number => input.callbackInputValue
}
const callableDescriptor = Object.getOwnPropertyDescriptor(callableHolder, 'callback')
console.log(typeof callableDescriptor?.value)
