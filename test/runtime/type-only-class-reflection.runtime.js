//! expect: empty

// A class named only inside a JSDoc type annotation. Nothing spells it in an
// expression, so a syntax walk never opens its declaration -- while the
// checker uses that same annotation to type a live cell, which puts the
// class's own carrier in the emission inventory. The two answers have to
// agree: a class that must be projected must also be reached, or its struct is
// rendered flat from the checker's whole flattened shape and its storage is
// reported unproven for want of a layout that was never missing.
import { Holder } from './_type-only-class-holder.js'

console.log(new Holder().describe())
