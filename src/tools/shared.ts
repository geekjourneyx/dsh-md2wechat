import type {
  GenericCallView,
  GenericResultView,
  ToolCallKind,
} from '@deepseek-ai/dsh-tools/presentation'
import { PLUGIN_VERSION, SUPPORTED_CLI_VERSION } from '../version.ts'

/**
 * Add independently versioned plugin and CLI diagnosis fields.
 * @param fields - Canonical domain result fields.
 * @returns A fresh result with plugin and compatible CLI versions.
 */
export function domainResult<T extends Readonly<Record<string, unknown>>>(
  fields: T,
): T & { pluginVersion: typeof PLUGIN_VERSION; cliVersion: typeof SUPPORTED_CLI_VERSION } {
  return { ...fields, pluginVersion: PLUGIN_VERSION, cliVersion: SUPPORTED_CLI_VERSION }
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
