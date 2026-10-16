console.log('value-module')
function effect():number {console.log('value-class');return 1}
export class Foo {static effect=effect()}
