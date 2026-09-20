// three's `Material`/`Object3D`/`Texture`/`BufferGeometry` shape: the field is
// annotated `Object` -- which a JS checker reads as `any` -- and the only
// value the program ever stores in it is a fresh empty literal.
export class Holder {
  constructor() {
    /**
     * An object that can be used to store custom data.
     *
     * @type {Object}
     */
    this.userData = {}
  }
}

const holder = new Holder()
console.log(Object.keys(holder.userData).length)
