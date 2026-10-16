import assert from 'node:assert/strict'
import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {writeFileSync,mkdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {compile} from '../dist/compiler.js'

test('constant conditional guards keep exactly one branch lazy through nested effects',()=>{
 const root=resolve(import.meta.dirname,'..'),dir=resolve(root,'measurements/constant-conditional');mkdirSync(dir,{recursive:true})
 const fixture=resolve(dir,'input.ts')
 writeFileSync(fixture,`let log='';
 function hit(label:string,value:number):number{log+=label;return value}
 function bad():number{throw new Error('unselected branch ran')}
 console.log((false)?bad():hit('a',2));
 console.log((true)?hit('b',3):bad());
 console.log((0)?bad():hit('c',4));
 console.log((1)?hit('d',5):bad());
 console.log((true)?((false)?bad():hit('e',6)):bad());
 let enabled=false;
 console.log(enabled?((true)?bad():bad()):hit('f',7));
 console.log(log);
 `)
 const result=compile({rootFileNames:[fixture],projectFileName:null})
 assert.ok(result.certificate,JSON.stringify(result.diagnostics.diagnostics));assert.deepEqual(result.loweringBlockers,[]);assert.deepEqual(result.emissionRefusals,[])
 const binary=resolve(dir,'test')
 execFileSync('clang++',['-std=c++20','-fsanitize=address,undefined',`-I${resolve(root,'src/targets/cpp/runtime')}`,'-x','c++','-','-o',binary],{input:result.source+'\nint main(){__gea_top_level();}\n'})
 const expected=execFileSync(process.execPath,[fixture],{encoding:'utf8'});assert.equal(execFileSync(binary,{encoding:'utf8'}),expected);assert.equal(expected,'2\n3\n4\n5\n6\n7\nabcdef\n')
})
