import { Mode } from './declaration-constant-values.js'
import { RivalMode } from './declaration-constant-rival.js'
export class ModeHolder {
  mode: Mode | RivalMode
  set(value: Mode | RivalMode): void
  copy(source: ModeHolder): void
}
