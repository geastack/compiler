// The codec module `read-only-dictionary-view-into-a-callee-a-typeof-test-observes`
// imports as a namespace, the way a driver imports node:zlib.

export interface ZstdOptions {
  params?: { [key: number]: number | boolean }
}

export const constants = { ZSTD_c_compressionLevel: 100 }

export function zstdCompress(input: string, options: ZstdOptions, callback: (error: Error | null, result: string) => void): void {
  const params = options.params
  let out = input
  if (params !== undefined) {
    for (const key of Object.keys(params)) out += `:${key}=${String(params[Number(key)])}`
  }
  callback(null, out)
}
