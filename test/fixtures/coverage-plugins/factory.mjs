import { inertPluginInstance } from '../../../dist/plugins/model.js'

export default () => ({ name: 'coverage-factory', instantiate: () => inertPluginInstance })
