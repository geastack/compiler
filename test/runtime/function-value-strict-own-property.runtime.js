//! expect-abort
//! emitted-has: callableNativeDataSetWithReceiver

/** @type {(() => void) & { name: string }} */
const entry = /** @type {any} */ (function entry() {})

function strictWrite() {
  'use strict'
  entry.name = 'must-throw'
}

strictWrite()
