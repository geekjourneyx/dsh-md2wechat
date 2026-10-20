import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'

/** Read-only policy for lifecycle tests, which never execute workspace effects. */
export function sandboxPolicyFixture(workspaceRoot: string): Pick<SandboxPolicyService, 'resolve'> {
  return {
    resolve(request = {}) {
      return {
        mode: request.mode ?? 'read-only',
        workspaceRoot: request.session?.header.cwd ?? workspaceRoot,
        ...(request.session === undefined ? {} : { sessionId: request.session.id }),
      }
    },
  }
}
