import * as namespace from './_construction-type-export-module'
function construct(Constructor:typeof namespace.Visible):namespace.Visible {return new Constructor()}
console.log('visible-value',construct(namespace.Visible).value)
//! expect: visible-module
//! expect: visible-constructor
//! expect: visible-value 1
//! emitted-lacks: TYPE_ONLY_MODULE_EFFECT_MUST_NOT_RUN
//! emitted-lacks: TYPE_ONLY_CLASS_EFFECT_MUST_NOT_RUN
//! emitted-lacks: TYPE_ONLY_CONSTRUCTOR_MUST_NOT_RUN
//! expect: value-module
//! expect: value-class
//! emitted-lacks: TYPE_ONLY_SHADOW_EFFECT_MUST_NOT_RUN
