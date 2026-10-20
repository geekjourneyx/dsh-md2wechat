import type {
  GenericCallView,
  GenericResultView,
  ToolCallKind,
} from '@deepseek-ai/dsh-tools/presentation'
import { PLUGIN_VERSION, UNKNOWN_CLI_VERSION } from '../version.ts'

/**
 * Add independently versioned plugin and CLI diagnosis fields.
 * @param fields - Canonical domain result fields.
 * @param cliVersion - Observed CLI version, or unknown when no CLI was involved.
 * @returns A fresh result with plugin and observed CLI versions.
 */
export function domainResult<T extends Readonly<Record<string, unknown>>>(
  fields: T,
  cliVersion: string = UNKNOWN_CLI_VERSION,
): T & { pluginVersion: typeof PLUGIN_VERSION; cliVersion: string } {
  return { ...fields, pluginVersion: PLUGIN_VERSION, cliVersion }
}

/**
 * Build a pure generic pending-call card.
 * @param title - Short call label.
 * @param kind - Native card category.
 * @param rawInput - Optional salient input.
 * @param locations - Optional file paths touched by the call.
 * @returns Generic DSH call presentation.
 */
export function genericCall(
  title: string,
  kind?: ToolCallKind,
  rawInput?: unknown,
  locations?: readonly string[],
): GenericCallView {
  return {
    card: 'generic',
    title,
    ...(kind === undefined ? {} : { kind }),
    ...(rawInput === undefined ? {} : { rawInput }),
    ...(locations === undefined ? {} : { locations: locations.map(path => ({ path })) }),
  }
}

/**
 * Build a pure generic completed-call card.
 * @param title - Optional replacement title.
 * @returns Generic DSH result presentation.
 */
export function genericResult(title?: string): GenericResultView {
  return { card: 'generic', ...(title === undefined ? {} : { title }) }
}
