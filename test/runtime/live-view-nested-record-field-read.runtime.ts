// A function typed against a narrow named shape (`CursorProject`, only
// `transport`) receives a value of a wider named shape (`Project`). Reading
// `project.transport.playhead` through the narrow view must read the
// original's nested record, before and after a write replaces it, for each
// of the two wider shapes that reach the one parameter.
//! expect: at=0
//! expect: at=48
//! expect: at=96
//! expect: read=12
export {}

type Transport = { readonly playhead: number; readonly loopEnabled?: boolean }
type CursorProject = { readonly transport: Transport }
type Project = { readonly id: string; readonly revision: number; transport: Transport }
type Playback = { readonly frame?: number }
type ReadProject = { readonly id: string; readonly transport: Transport; readonly sampleRate: number }

function cursorFrame(project: CursorProject, playback: Playback | null | undefined): number {
  return playback?.frame ?? project.transport.playhead
}

const project: Project = { id: 'p1', revision: 1, transport: { playhead: 0 } }
console.log(`at=${cursorFrame(project, null)}`)
project.transport = { playhead: 48, loopEnabled: true }
console.log(`at=${cursorFrame(project, undefined)}`)
console.log(`at=${cursorFrame(project, { frame: 96 })}`)
const read: ReadProject = { id: 'r1', transport: { playhead: 12 }, sampleRate: 48000 }
console.log(`read=${cursorFrame(read, null)}`)
