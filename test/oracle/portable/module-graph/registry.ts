import { pluginBias } from './plugins.js'

const names: string[] = []

export function register(name: string, weight: number): number {
  names.push(name)
  return names.length * weight + pluginBias(name)
}

export function registered(): string {
  return names.join(',')
}
