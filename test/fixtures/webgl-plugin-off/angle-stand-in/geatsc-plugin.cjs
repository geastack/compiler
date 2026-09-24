// Stands in for `@geastack/native-webgl-angle/geatsc-plugin`: the same
// `configure().hostShims` shape, stating the two things the real package does
// to three.js -- a `// @ts-nocheck` prefix on its `src/*.js` files and `self`
// among its absent globals. Every call is logged, so a test can tell whether
// the compiler consulted the package at all.
const { appendFileSync } = require('node:fs')

const log = (line) => {
  if (process.env.WEBGL_STAND_IN_LOG) appendFileSync(process.env.WEBGL_STAND_IN_LOG, `${line}\n`)
}

module.exports.default = {
  name: 'native-webgl-angle-stand-in',
  configure() {
    log('configure')
    return {
      hostShims: {
        absentGlobals: ['self'],
        transformSource({ fileName, text }) {
          const path = fileName.replace(/\\/g, '/')
          if (!/\/fake-three\/src\/[^/]+\.js$/.test(path)) return null
          log(`transform ${path.slice(path.indexOf('fake-three/'))}`)
          return `// @ts-nocheck\n${text}`
        }
      }
    }
  }
}
