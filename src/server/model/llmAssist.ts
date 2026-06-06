import { generateText } from 'ai';
import type { Model } from './forecast.ts';
import { getActiveModel } from '../ai/providers.ts';

export interface Assist {
  /** Directional bias in [-1, 1]; positive = lean bullish. */
  bias: number;
  narrative: string;
  reasoning?: string;
  llmApplied: boolean;
}

/** Max probability nudge applied to the 5m/15m up-probabilities. */
const MAX_NUDGE = 0.08;

/** Apply the LLM bias to an up-probability, clamped to a sane band. */
export function applyBias(probUp: number, bias: number): number {
  const nudged = probUp + bias * MAX_NUDGE;
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
    `(Set LLM_MODEL + an API key for LLM-assisted reasoning.)`;
  return { bias: 0, narrative, llmApplied: false };
}

async function llmAssist(
  model: Model,
  llm: Parameters<typeof generateText>[0]['model']
): Promise<Assist> {
  const s = model.stats;
  const prompt =
    `You are a short-horizon BTC/USDT analyst. Current price $${s.price.toFixed(0)}.\n` +
    `Recent stats from Binance candles:\n` +
    `- per-minute log-return drift: ${(s.driftPerMin * 1e4).toFixed(3)} bp/min\n` +
    `- per-minute volatility: ${(s.volPerMin * 100).toFixed(4)}%\n` +
    `- per-hour volatility: ${(s.volPerHour * 100).toFixed(3)}%\n` +
    `- 24h change: ${s.change24hPct.toFixed(2)}%\n\n` +
    `Give a directional read for the next 5-15 minutes. Be calibrated: short-horizon ` +
    `moves are near random, so keep bias small unless momentum is clear.\n` +
    `Return ONLY JSON: {"bias": <-1..1, lean bullish/bearish>, ` +
    `"narrative": "<one sentence read>", "reasoning": "<2-3 sentences>"}`;

  const { text } = await generateText({
    model: llm,
    prompt,
    maxOutputTokens: 2048,
    providerOptions: { lmstudio: { enable_thinking: false } },
  });

  const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(match ? match[0] : '{}') as {
    bias?: number;
    narrative?: string;
    reasoning?: string;
  };

  const bias = Math.max(-1, Math.min(1, Number(parsed.bias) || 0));
  return {
    bias,
    narrative: parsed.narrative ?? 'LLM read applied.',
    reasoning: parsed.reasoning,
    llmApplied: true,
  };
}
