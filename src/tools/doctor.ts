import { PLUGIN_VERSION } from '../version.ts'
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

const expectedProbeCodes = {
  version: 'VERSION_SHOWN',
  capabilities: 'CAPABILITIES_SHOWN',
  config: 'CONFIG_VALIDATED',
  providers: 'PROVIDERS_SHOWN',
} as const

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
          pluginVersion: { type: 'string', const: PLUGIN_VERSION, required: true },
          cliVersion: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ready
          ? `md2wechat is ready. ${formatProbes(value.probes)}`
          : `md2wechat is not ready. ${formatProbes(value.probes)}`,
      }],
    },
    async execute(args, exec) {
      if (Object.keys(args).length > 0) throw new Error('md2wechat_doctor does not accept arguments')
      const probes: ProbeResult[] = []
      let cliVersion: string | undefined
      for (const [name, argv] of [
        ['version', ['version', '--json']],
        ['capabilities', ['capabilities', '--json']],
        ['config', ['config', 'validate', '--json']],
        ['providers', ['providers', 'list', '--json']],
      ] as const) {
        const result = await safeProbe(gateway, name, argv, exec.signal)
        probes.push(result.probe)
        if (name === 'version') cliVersion = result.cliVersion
      }
      return domainResult({ ready: probes.every(probe => probe.ready), probes }, cliVersion)
    },
    presentCall: () => genericCall('Check md2wechat readiness', 'read'),
    presentResult: () => genericResult('md2wechat diagnosis complete'),
  })
}

async function safeProbe(
  gateway: CliGateway,
  name: keyof typeof expectedProbeCodes,
  argv: readonly string[],
  signal: AbortSignal,
): Promise<{ probe: ProbeResult; cliVersion?: string }> {
  try {
    const response = await gateway.run(argv, { signal })
    return { probe: publicProbe(name, response), ...(name === 'version' && typeof response.data?.version === 'string' ? { cliVersion: response.data.version } : {}) }
  } catch {
    if (signal.aborted) signal.throwIfAborted()
    return { probe: { name, ready: false, code: `${name.toUpperCase()}_PROBE_FAILED`, status: 'failed' } }
  }
}

function publicProbe(name: keyof typeof expectedProbeCodes, response: CliEnvelope): ProbeResult {
  const ready = response.success
    && response.status === 'completed'
    && response.code === expectedProbeCodes[name]
  return {
    name,
    ready,
    code: ready ? expectedProbeCodes[name] : `${name.toUpperCase()}_NOT_READY`,
    status: ready ? 'completed' : 'failed',
  }
}

function formatProbes(probes: readonly ProbeResult[]): string {
  return probes.map(probe => `${probe.name}: ${probe.ready ? 'ready' : `not ready (${probe.code})`}`).join('; ')
}
