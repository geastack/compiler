interface Descriptor {
  width: number
  height: number
  depth: number
}

export declare class Faces {
  get images(): Descriptor[]
  set images(value: Descriptor[])
}

export declare class Counter {
  get value(): number
  set value(value: number | string)
  static get value(): string
  static set value(value: string)
}

export declare class Label {
  get value(): string
  set value(value: string)
}

export declare class Repeated {
  get value(): number
  get value(): string
}

export declare class Generic<T> {
  get value(): T
  set value(value: T)
}

export declare class Unresolved {
  get value(): MissingDeclaration
}

export declare class TupleFaces {
  get images(): [Descriptor, Descriptor]
  set images(value: [Descriptor, Descriptor])
}
