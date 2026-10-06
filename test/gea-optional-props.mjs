import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'
import { geaPlugin } from '../dist/plugins/gea/plugin.js'
import { allOperationsOf } from '../dist/ir/model.js'
const entry=resolve('test/fixtures/jsx/class-component.tsx')
const source=`import { Component } from '@geastack/core'
interface Props { width: number; id: string }
class Row extends Component<Props> {
 template(props?: Props): JSX.Element {
  return <text width={props ? props.width : 0}>{props ? props.id : 'absent'}</text>
 }
}
export const tree: JSX.Element = <Row width={12} id="present" />
`
test('JSX fills optional component props through a native present record',()=>{
 const result=compile({rootFileNames:[entry,resolve('test/fixtures/jsx/jsx.d.ts')],plugins:[geaPlugin],projectFileName:resolve('test/fixtures/jsx/tsconfig.json'),sourceOverlay:new Map([[entry,source],[resolve('test/fixtures/jsx/framework.tsx'),'export class Component<Props = void> { template(props?: Props): JSX.Element { return <view /> } }']]),includeIr:true})
 assert.notEqual(result.certificate,null,JSON.stringify({blockers:result.loweringBlockers,refusals:result.refusals,diagnostics:result.diagnostics}))
 const operations=(result.irBodies??[]).flatMap(body=>[...body.blocks.values()].flatMap(allOperationsOf))
 assert.ok(operations.some(op=>op.kind==='convert'&&op.result.representation.kind==='optional'&&op.result.representation.payload.kind==='record'))
})
