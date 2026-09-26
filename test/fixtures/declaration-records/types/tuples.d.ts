// `Euler.d.ts`'s own shape: the tuple a JS tag spells as `Array<number,number,number,?string>`.
export type Order = 'XYZ' | 'YXZ'
export type Triple = [x: number, y: number, z: number, order?: Order]
export declare class Angles {
  fromArray(array: Triple): Angles
  scale(values: number[]): Angles
}
