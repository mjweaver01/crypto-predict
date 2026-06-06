import { generateObject } from 'ai';
import { z } from 'zod';
import type { Model } from './forecast.ts';
import { getActiveModel } from '../ai/providers.ts';

/**
 * Schema for the LLM's structured read. Sent to LM Studio as a JSON Schema so
 * decoding is grammar-constrained — output is guaranteed valid and typed, with
 * no regex extraction or `<think>` stripping needed.
 */
const AssistSchema = z.object({
  bias: z.number().min(-1).max(1).describe('lean: -1 bearish .. 1 bullish'),
  narrative: z.string().describe('one-sentence read'),
  reasoning: z.string().describe('2-3 sentences'),
});

export interface Assist {
  /** Directional bias in [-1, 1]; positive = lean bullish. */
  bias: number;
  narrative: string;
  reasoning?: string;
  llmApplied: boolean;
}

/** Max probability nudge applied to the up-probabilities (at short horizons). */
const MAX_NUDGE = 0.08;

/**
 * Horizon (minutes) over which the LLM nudge decays to ~37%. The model is
 * prompted for a 5-15 minute directional read, so its influence should fade
 * over longer windows rather than move a 10-hour forecast by the full amount.
 */
const NUDGE_DECAY_MIN = 20;

/**
 * Apply the LLM bias to an up-probability, scaled down with horizon and clamped
 * to a sane band. `horizonMinutes` defaults to short-horizon (full nudge).
 */
export function applyBias(
  probUp: number,
  bias: number,
  horizonMinutes = 0
): number {
  const decay = Math.exp(-Math.max(0, horizonMinutes) / NUDGE_DECAY_MIN);
  const nudged = probUp + bias * MAX_NUDGE * decay;
  return Math.max(0.02, Math.min(0.98, nudged));
}

/**
 * Optional reasoning layer. Asks the configured model for a short read on
 * near-term direction and a small bias. Falls back to a transparent,
 * stats-only narrative when no provider is available.
 */
export async function assist(model: Model): Promise<Assist> {
  try {
    const llm = getActiveModel();
    return await llmAssist(model, llm);
  } catch (err) {
    console.warn('[llmAssist] LLM unavailable, using stats narrative:', err);
    return heuristic(model);
  }
}

function heuristic(model: Model): Assist {
  const { change24hPct, driftPerMin, volPerMin } = model.stats;
  const dir = driftPerMin > 0 ? 'slight upward' : 'slight downward';
  const narrative =
    `Recent 1m drift is ${dir} (${(driftPerMin * 1e4).toFixed(2)} bp/min) ` +
    `with ${(volPerMin * 100).toFixed(3)}% per-minute volatility; ` +
    `BTC is ${change24hPct >= 0 ? 'up' : 'down'} ${Math.abs(change24hPct).toFixed(2)}% over 24h. ` +
    `(Set LLM_MODEL for LLM-assisted reasoning — e.g. a local LM Studio model like ` +
    `qwen/qwen3-4b (no key), or a hosted model with its API key.)`;
  return { bias: 0, narrative, llmApplied: false };
}

async function llmAssist(
  model: Model,
  llm: Parameters<typeof generateObject>[0]['model']
): Promise<Assist> {
  const s = model.stats;
  // Compact prompt: terse stats, no JSON-format instructions (the schema
  // handles shape). Fewer input tokens + grammar-constrained output = faster.
  const prompt =
    `BTC/USDT $${s.price.toFixed(0)}. Next 5-15min directional read. ` +
    `Short-horizon moves are near-random; keep bias small unless momentum is clear.\n` +
    `drift ${(s.driftPerMin * 1e4).toFixed(2)}bp/min, ` +
    `vol/min ${(s.volPerMin * 100).toFixed(3)}%, ` +
    `vol/hr ${(s.volPerHour * 100).toFixed(2)}%, ` +
    `24h ${s.change24hPct.toFixed(2)}%`;

  const { object } = await generateObject({
    model: llm,
    schema: AssistSchema,
    prompt,
    maxOutputTokens: 256,
    providerOptions: { lmstudio: { enable_thinking: false } },
  });

  return {
    bias: Math.max(-1, Math.min(1, object.bias)),
    narrative: object.narrative,
    reasoning: object.reasoning,
    llmApplied: true,
  };
}
