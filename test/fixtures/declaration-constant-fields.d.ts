import { Mode } from './declaration-constant-values.js'
export class ModeHolder {
  mode: Mode
  set(value: Mode): void
  copy(source: ModeHolder): void
}
