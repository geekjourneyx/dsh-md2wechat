#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { appendFile, access, readFile } from 'node:fs/promises'

const argv = process.argv.slice(2)
const behavior = process.env.FAKE_MD2WECHAT_BEHAVIOR ?? 'normal'
const commands = [
  'inspect',
  'advise',
  'preview',
  'config',
  'write',
  'humanize',
  'title',
  'upload_image',
  'download_and_upload',
  'generate_image',
  'generate_cover',
  'generate_infographic',
  'create_draft',
  'providers',
  'capabilities',
  'version',
]

function completed(data = {}) {
  return {
    success: true,
    code: 'OK',
    message: 'completed',
    schema_version: 'v1',
    status: 'completed',
    retryable: false,
    data,
  }
}

function retryableFailure() {
  return {
    success: false,
    code: 'TEMPORARY_FAILURE',
    message: 'retry later',
    schema_version: 'v1',
    status: 'failed',
    retryable: true,
  }
}

function response() {
  if (argv[0] === 'version') return completed({ version: process.env.FAKE_MD2WECHAT_VERSION ?? '3.3.0' })
  if (argv[0] === 'capabilities') return completed({ commands })
  return completed({ argv })
}

async function recordAttempt() {
  const counterFile = process.env.FAKE_MD2WECHAT_COUNTER_FILE
  if (counterFile === undefined) return 1
  await appendFile(counterFile, 'attempt\n')
  const attempts = await readFile(counterFile, 'utf8')
  return attempts.trim().split('\n').length
}

switch (behavior) {
  case 'malformed':
    process.stdout.write('{not-json')
    break
  case 'multiple-json':
    process.stdout.write(`${JSON.stringify(response())}\n${JSON.stringify(response())}\n`)
    break
  case 'stderr-secret':
    process.stderr.write(`diagnostic: ${process.env.WECHAT_SECRET ?? ''}\n`)
    process.stdout.write(`${JSON.stringify(response())}\n`)
    process.exitCode = 17
    break
  case 'sleep': {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
      stdio: 'ignore',
    })
    const pidFile = process.env.FAKE_MD2WECHAT_PID_FILE
    if (pidFile !== undefined) {
      await appendFile(pidFile, `${process.pid}\n${child.pid ?? -1}\n`)
    }
    setTimeout(() => {}, 60_000)
    break
  }
  case 'oversize':
    process.stdout.write('x'.repeat(1024 * 1024 + 1))
    break
  case 'signal':
    process.kill(process.pid, 'SIGTERM')
    break
  case 'invalid-version':
    process.stdout.write(`${JSON.stringify(completed({ version: '' }))}\n`)
    break
  case 'missing-capability':
    process.stdout.write(`${JSON.stringify(completed({
      commands: commands.slice(0, -1),
    }))}\n`)
    break
  case 'retry-once': {
    const attempt = await recordAttempt()
    process.stdout.write(`${JSON.stringify(attempt === 1 ? retryableFailure() : response())}\n`)
    if (attempt === 1) process.exitCode = 75
    break
  }
  case 'stdin': {
    let stdin = ''
    for await (const chunk of process.stdin) stdin += chunk
    process.stdout.write(`${JSON.stringify(completed({ stdin }))}\n`)
    break
  }
  case 'cwd':
    process.stdout.write(`${JSON.stringify(completed({ cwd: process.cwd() }))}\n`)
    break
  case 'require-marker': {
    const marker = process.env.FAKE_MD2WECHAT_MARKER_FILE
    try {
      if (marker === undefined) throw new Error('missing marker')
      await access(marker)
      process.stdout.write(`${JSON.stringify(response())}\n`)
    } catch {
      process.stdout.write(`${JSON.stringify(retryableFailure())}\n`)
      process.exitCode = 75
    }
    break
  }
  case 'normal':
    process.stdout.write(`${JSON.stringify(response())}\n`)
    break
  default:
    process.stderr.write(`unknown behavior: ${behavior}\n`)
    process.exitCode = 2
}
