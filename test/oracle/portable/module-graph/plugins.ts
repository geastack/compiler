import { register } from './registry.js'

export function pluginBias(name: string): number {
  return name.length % 3
}

export function installDefaults(): number {
  return register('alpha', 2) + register('beta', 3)
}
