import { Group, Range, Tint } from './group.js'

// The shape of `@types/three`'s `WebGLState.d.ts`: the records a factory's
// nested factories return are declared as classes no JS module exports, with
// the same member names and different parameter lists.
declare class ColorChannel {
  setMask(colorMask: boolean): void
  setClear(r: number, g: number, b: number, a: number, premultipliedAlpha: boolean): number
  reset(): void
}

declare class DepthChannel {
  setMask(depthMask: boolean): void
  setClear(depth: number): number
}

// The shape of `@types/three`'s `WebGLLightsState`: plain data whose array
// members the package leaves as `unknown[]`.
interface LightsState {
  version: number
  probe: unknown[]
}

export declare class Pipeline {
  constructor(width: number)
  channels: {
    color: ColorChannel
    depth: DepthChannel
  }
  enable(id: number): number
  draw(count: number, group: Group, tint: Tint): number
  span(range: Range): number
  bind(channel: ColorChannel, slot: number): number
  lookup(key: unknown): unknown
  describe(label: string): string
  gather(items: unknown[]): number
  setup(lights: LightsState): number
  total(values: number[]): number
  visit(callback: (tint: Tint) => any): number
  attach(handler: { name: string; run(): any }): number
}
