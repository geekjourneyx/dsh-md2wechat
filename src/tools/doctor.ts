import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CliEnvelope } from '../cli/protocol.ts'
import type { CliGateway } from '../cli/gateway.ts'
import { domainResult, genericCall, genericResult } from './shared.ts'

interface DoctorToolDependencies {
  gateway: CliGateway
}

interface ProbeResult {
  name: string
  ready: boolean
  code: string
  status: 'completed' | 'action_required' | 'failed'
}

const probeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    ready: { type: 'boolean', required: true },
    code: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['completed', 'action_required', 'failed'] },
  },
} as const

/**
 * Create the safe md2wechat environment diagnostic tool.
 * @param dependencies - Managed CLI gateway used for read-only probes.
 * @returns Registry-ready typed DSH tool.
 */
export function createDoctorTool({ gateway }: DoctorToolDependencies) {
  return defineTool({
    name: 'md2wechat_doctor',
    description: 'Check the configured md2wechat CLI, configuration, and provider readiness without exposing credentials.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ready: { type: 'boolean', required: true },
          probes: { type: 'array', required: true, items: probeSchema },
          pluginVersion: { type: 'string', const: '1.0.0', required: true },
          cliVersion: { type: 'string', const: '3.3.0', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ready
          ? `md2wechat is ready. ${formatProbes(value.probes)}`
          : `md2wechat is not ready. ${formatProbes(value.probes)}`,
      }],
    },
    async execute(args) {
      if (Object.keys(args).length > 0) throw new Error('md2wechat_doctor does not accept arguments')
      const probes: ProbeResult[] = []
      for (const [name, argv] of [
        ['version', ['version', '--json']],
        ['capabilities', ['capabilities', '--json']],
        ['config', ['config', 'validate', '--json']],
        ['providers', ['providers', 'list', '--json']],
      ] as const) {
        probes.push(await safeProbe(gateway, name, argv))
      }
      return domainResult({ ready: probes.every(probe => probe.ready), probes })
    },
    presentCall: () => genericCall('Check md2wechat readiness', 'read'),
    presentResult: () => genericResult('md2wechat diagnosis complete'),
  })
}

async function safeProbe(gateway: CliGateway, name: string, argv: readonly string[]): Promise<ProbeResult> {
  try {
    return publicProbe(name, await gateway.run(argv))
  } catch {
    return { name, ready: false, code: 'PROBE_FAILED', status: 'failed' }
  }
}

function publicProbe(name: string, response: CliEnvelope): ProbeResult {
  return {
    name,
    ready: response.success && response.status !== 'failed',
    code: response.code,
    status: response.status,
  }
}

function formatProbes(probes: readonly ProbeResult[]): string {
  return probes.map(probe => `${probe.name}: ${probe.ready ? 'ready' : `not ready (${probe.code})`}`).join('; ')
}
