// `export =` of a function that also carries itself as named expandos, the
// shape a string-normalizer package ships (`normalize.normalize = normalize;
// export = normalize`). Imported by `named-import-of-export-assigned-function-expando`.
function normalize(input: string, opts?: { upper?: boolean }): string {
  return opts?.upper ? input.toUpperCase() : input.trim()
}

normalize.normalize = normalize
normalize.default = normalize

export = normalize
