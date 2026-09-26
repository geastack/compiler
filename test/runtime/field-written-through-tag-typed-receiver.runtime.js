//! expect: none
//! expect: pipeline 1
//! expect: shared 1
// three's `RenderObject.pipeline`: a field initialized to `null` in the
// constructor under a tag naming no declaration, and filled only in another
// file, `renderObject.pipeline = pipeline` in `Pipelines.getForRender`, where
// `@param {RenderObject}` names a class that file never imports. The
// receiver is typed only by that tag read program-wide; the write is still a
// write into the field.
import { RenderItem } from './_field-tag-receiver-item.js'
import { Pipelines } from './_field-tag-receiver-cache.js'

const first = new RenderItem('a')
const second = new RenderItem('a')
const pipelines = new Pipelines()
console.log(first.pipeline === null ? 'none' : 'early')
// Exported, so code outside the program may call `getFor` and no census
// types `item` from its call sites, as three's `Pipelines` methods escape.
export { pipelines }
pipelines.getFor(first, null)
pipelines.getFor(second, [])
console.log(first.pipeline === null ? 'none' : 'pipeline ' + first.pipeline.id)
console.log(second.pipeline === null ? 'none' : 'shared ' + second.pipeline.id)
