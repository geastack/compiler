// A connection-string URL package's `class URLWithoutHost extends URL`, where
// `URL` is imported from a module that exports `const URLAlias = URL`. The
// base's identity follows the alias into that module, but the heritage VALUE
// is the import read in this file: the alias target is an expression of
// another module, and lowering this module body cannot cite its result.
import { Location } from './_const-class-alias-export.js'

class ConnectionString extends Location {
  get isSrv(): boolean {
    return this.scheme === 'service+srv'
  }
}

const url = new ConnectionString('service+srv://cluster0.example.net')
//! expect: service+srv true true
console.log(url.scheme + ' ' + url.isSrv + ' ' + (url instanceof Location))
