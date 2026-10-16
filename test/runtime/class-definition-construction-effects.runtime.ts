// The imported Dormant definition executes its computed/static effects but is
// never constructed. The two real construction routes retain base/field/body order.
import {Constructed} from './_class-definition-construction-effects'
function constructEscaped(Constructor:typeof Constructed):Constructed { return new Constructor() }
console.log('entry')
console.log('direct',new Constructed().value)
console.log('escaped',constructEscaped(Constructed).own)
//! expect: computed
//! expect: dormant-static
//! expect: base-static
//! expect: derived-static
//! expect: direct 1
//! expect: escaped 1
//! emitted-lacks: DORMANT_INSTANCE_MUST_NOT_RUN
//! emitted-lacks: DORMANT_CONSTRUCTOR_MUST_NOT_RUN
