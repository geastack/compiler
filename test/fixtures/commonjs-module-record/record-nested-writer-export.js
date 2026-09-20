'use strict'

function exported(value) {
  return value
}

function mutateExport() {
  module.exports.extra = true
}

module.exports = exported
mutateExport()
