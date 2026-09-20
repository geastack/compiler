declare interface RouteHandler<Schema> {
  (value: Schema): AmbientRouter<Schema>
}

declare class AmbientRouter<Schema> {
  handler: RouteHandler<Schema>
  count: number
}
