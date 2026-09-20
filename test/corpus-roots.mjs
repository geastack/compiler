// Some tests here compile REAL third-party applications -- three.js from the
// example apps, fastify/hono/mongodb from the node-compat apps. That corpus is
// not part of this repository and is not a package this one depends on, so its
// location is supplied, never guessed: a sibling-checkout default only ever
// resolves on the machine it was written on.
//
// GEA_APPS_ROOT is the app project root (the gea CLI sets it the same way).
// GEA_NODE_COMPAT_ROOT is a checkout of geastack/node-compat.
//
// Each returns '' when unset, and the caller skips rather than failing: a
// missing corpus is a checkout that does not have it, not a defect here.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const rootFrom = (variable, marker) => {
  const value = process.env[variable]
  if (!value) return ''
  const root = resolve(value)
  return existsSync(resolve(root, marker)) ? root : ''
}

export const appsRoot = () => rootFrom('GEA_APPS_ROOT', 'apps')
export const nodeCompatRoot = () => rootFrom('GEA_NODE_COMPAT_ROOT', 'apps')

export const skipWithout = (root, variable) =>
  root ? false : `set ${variable} to a checkout that holds the corpus for this test`
