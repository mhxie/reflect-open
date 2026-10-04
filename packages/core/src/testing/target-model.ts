import type { LanguageModel } from '@reflect/modules/ai'
import type { TargetModel } from '../ai/language-model.ts'
import type { ModelTarget } from '../privacy/on-device.ts'

/**
 * Test-only stand-in for `languageModelFor`: binds a mock model (such as
 * `MockLanguageModelV3`) to `target`, so engine tests run without a provider.
 * Production code never imports this module.
 */
export function testTargetModel<TTarget extends ModelTarget>(
  target: TTarget,
  model: LanguageModel,
): TargetModel<TTarget> {
  return Object.freeze({ target, model }) as TargetModel<TTarget>
}
