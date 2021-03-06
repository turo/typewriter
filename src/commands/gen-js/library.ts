import { TrackedEvent } from '../../lib/cli'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import { version } from '../../../package.json'
import { camelCase } from 'lodash'
import * as prettier from 'prettier'
import * as Ajv from 'ajv'
import { command, Client } from '.'
import { preprocessRules } from '../../lib/rules'

function getFnName(eventName: string) {
  return camelCase(eventName.replace(/^\d+/, ''))
}

export function genJS(
  events: TrackedEvent[],
  scriptTarget = ScriptTarget.ESNext,
  moduleKind = ModuleKind.ESNext,
  client = Client.js,
  runtimeValidation = true
) {
  // AJV defaults to JSON Schema draft-07
  const ajv = new Ajv({ schemaId: 'auto', allErrors: true, sourceCode: true })
  ajv.addMetaSchema(require('ajv/lib/refs/json-schema-draft-06.json'))
  ajv.addMetaSchema(require('ajv/lib/refs/json-schema-draft-04.json'))

  const clientName = client === Client.js ? 'analytics.js' : 'analytics-node'
  const analyticsValidation = `
  if (!analytics) {
    throw new Error('An instance of ${clientName} must be provided')
  }`
  const errorHandler = `
  this.onError = options.onError || (error => {
    throw new Error(JSON.stringify(error, null, 2));
  })`
  const fileHeader = `
    export default class Analytics {
      /**
       * Instantiate a wrapper around an analytics library instance
       * @param {Analytics} analytics The ${clientName} library to wrap
       * @param {Object} [options] Optional configuration of the Typewriter client
       * @param {function} [options.onError] Error handler fired when run-time validation errors
       *     are raised.
       */
      constructor(analytics, options = {}) {
        ${runtimeValidation ? analyticsValidation : ''}
        this.analytics = analytics || { track: () => null }
        ${runtimeValidation ? errorHandler : ''}
      }

      addTypewriterContext(context = {}) {
        return {
          ...context,
          typewriter: {
            name: "${command}",
            version: "${version}"
          }
        }
      }
  `

  const trackCalls =
    events.reduce((code, { name, rules }) => {
      const sanitizedFnName = getFnName(name)
      const sanitizedEventName = name.replace(/'/g, "\\'")

      // source is just an object; TODO: an upstream PR to specify the type of `source`
      const compiledValidationSource: any = ajv.compile(preprocessRules(rules)).source
      const compiledValidationFn = compiledValidationSource.code.replace(/return validate;/, '')

      let parameters = ''
      let trackCall = ''
      let validateCall = ''
      if (client === Client.js) {
        parameters = 'props = {}, options = {}, callback'
        trackCall = `this.analytics.track('${sanitizedEventName}', props, {
          ...options,
          context: this.addTypewriterContext(options.context)
        }, callback)`
        validateCall = 'validate({ properties: props })'
      } else if (client === Client.node) {
        parameters = 'message = {}, callback'
        trackCall = `
        message = {
          ...message,
          context: this.addTypewriterContext(message.context),
          event: '${sanitizedEventName}'
        }
        this.analytics.track(message, callback)`
        validateCall = 'validate(message)'
      }

      const validationCode = `
      ${compiledValidationFn}
      if (!${validateCall}) {
        this.onError({ eventName: '${sanitizedEventName}', validationErrors: validate.errors })
        return
      }`

      return `
      ${code}
      ${sanitizedFnName}(${parameters}) {
        ${runtimeValidation ? validationCode : ''}
        ${trackCall}
      }
    `
    }, fileHeader) + '} '

  const { outputText } = transpileModule(trackCalls, {
    compilerOptions: {
      target: scriptTarget,
      module: moduleKind
    }
  })

  return prettier.format(outputText, { parser: 'babylon' })
}
