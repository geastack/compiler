// A matching name alone must never silently select a built-in adapter.
export default () => ({ name: 'gea', configure() {} })
