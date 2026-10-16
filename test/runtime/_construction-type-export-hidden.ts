console.log('TYPE_ONLY_MODULE_EFFECT_MUST_NOT_RUN')
export class Hidden {
 static effect=console.log('TYPE_ONLY_CLASS_EFFECT_MUST_NOT_RUN');
 constructor(){console.log('TYPE_ONLY_CONSTRUCTOR_MUST_NOT_RUN')}
}
export class Foo {static effect=console.log('TYPE_ONLY_SHADOW_EFFECT_MUST_NOT_RUN')}
