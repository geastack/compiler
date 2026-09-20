class VirtualKeyBase {
  emit(_name: string | symbol): string {
    return 'base'
  }
}

class VirtualKeyDerived extends VirtualKeyBase {
  override emit(name: string): string {
    return 'derived:' + name
  }
}

const emitter = new VirtualKeyDerived()

//! expect: derived:ready
console.log(emitter.emit('ready'))
