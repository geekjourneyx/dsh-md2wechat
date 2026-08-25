import type { CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import type { CredentialEnvironmentName } from '../config.ts'

const allowedNames = new Set<CredentialEnvironmentName>([
  'MD2WECHAT_API_KEY',
  'WECHAT_APPID',
  'WECHAT_SECRET',
  'IMAGE_API_KEY',
])
const credentialReference = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** Credential service subset required for one operation. */
export interface OperationCredentialServices {
  credentialRefs: Readonly<Record<string, string>>
  credentials: {
    resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
  }
}

/** Isolated environment and redaction values resolved for one CLI operation. */
export interface ResolvedOperationEnv {
  env: Readonly<Record<string, string>>
  secrets: readonly string[]
}

/**
 * Resolve only the credential environment names required by one operation.
 * @param names - Approved CLI environment names needed for this invocation.
 * @param services - Configured references and the DSH credential provider.
 * @returns Resolved CLI environment values and the same secrets for redaction.
 */
export async function resolveOperationEnv(
  names: readonly CredentialEnvironmentName[],
  services: OperationCredentialServices,
): Promise<ResolvedOperationEnv> {
  const env: Record<string, string> = {}
  const secrets: string[] = []
  for (const name of new Set(names)) {
    if (!allowedNames.has(name)) throw new TypeError(`credential environment name ${name} is not supported`)
    const reference = services.credentialRefs[name]
    if (reference === undefined) continue
    if (!credentialReference.test(reference)) throw new TypeError(`credential reference for ${name} is invalid`)
    const resolved = await services.credentials.resolve(reference as CredentialRef)
    if (resolved === undefined) throw new Error(`credential configured for ${name} could not be resolved`)
    env[name] = resolved.value
    secrets.push(resolved.value)
  }
  return { env, secrets }
}
