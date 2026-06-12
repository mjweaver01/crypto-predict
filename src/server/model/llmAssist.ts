import { generateObject } from 'ai';
import { z } from 'zod';
import type { Model } from './forecast.ts';
import { getActiveModel } from '../ai/providers.ts';

/**
 * Schema for the LLM's structured read. Sent to LM Studio as a JSON Schema so
 * decoding is grammar-constrained — output is guaranteed valid and typed, with
 * no regex extraction or `<think>` stripping needed. Avoid `.max()` length
 * constraints on string fields — llama.cpp's grammar engine does not support
 * `maxLength` and will hang on "processing prompt". Use `.describe()` instead.
 */
const AssistSchema = z.object({
  bias: z.number().min(-1).max(1).describe('lean: -1 bearish .. 1 bullish'),
  narrative: z
    .string()
    .describe(
      'punchy headline, ONE short sentence under 120 characters: the lean and the single key level'
    ),
  reasoning: z
    .string()
    .describe(
      'full report in short paragraphs (aim for 200-400 words): momentum and volatility read, each window call with its level, where the market disagrees, and the main risk to the lean'
    ),
});

export interface Assist {
  /** Directional bias in [-1, 1]; positive = lean bullish. */
  bias: number;
  narrative: string;
  reasoning?: string;
  llmApplied: boolean;
}

/** The model's base directional read for one window, used to ground the LLM. */
export interface WindowRead {
  /** Human label, e.g. "5 min". */
  label: string;
  /** Minutes remaining until the window resolves. */
  horizonMin: number;
  /** Price to beat at the window open. */
  strike: number;
  /** Base model P(up) before any LLM bias. */
  probUp: number;
  /** Market-implied P(up), when a live market exists. */
  marketImpliedUp?: number;
}

/** Concrete context handed to the LLM so its read references real levels. */
export interface AssistContext {
  /** Pair label, e.g. "BTC/USDT" — keeps the read on the right asset. */
  asset?: string;
  /** Current spot price. */
  price: number;
  /** Per-window base reads, shortest horizon first. */
  reads: WindowRead[];
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
 * near-term direction and a small bias, grounded in the model's own per-window
 * calls so the narrative cites real levels. Falls back to a transparent,
 * stats-only narrative when no provider is available.
 */
export async function assist(
  model: Model,
  ctx?: AssistContext
): Promise<Assist> {
  try {
    const llm = getActiveModel();
    return await llmAssist(model, llm, ctx);
  } catch (err) {
    console.warn('[llmAssist] LLM unavailable, using stats narrative:', err);
    return heuristic(model, ctx);
  }
}

const pct = (p: number) => Math.round(Math.max(p, 1 - p) * 100);
const dirOf = (p: number) => (p >= 0.5 ? 'UP' : 'DOWN');

/**
 * Render the model's per-window calls as terse lines the LLM (or fallback) can
 * anchor to, e.g. `5 min: spot above $104,230 strike, model 58% UP, mkt 53%`.
 */
function readLines(ctx: AssistContext): string {
  return ctx.reads
    .map(r => {
      const vs = ctx.price >= r.strike ? 'above' : 'below';
      const mkt =
        r.marketImpliedUp != null
          ? `, mkt ${Math.round(r.marketImpliedUp * 100)}% up`
          : '';
      return (
        `${r.label}: spot ${vs} $${r.strike.toLocaleString('en-US', { maximumFractionDigits: 0 })} strike, ` +
        `model ${pct(r.probUp)}% ${dirOf(r.probUp)}${mkt}`
      );
    })
    .join('\n');
}

/**
 * The dependency-free stats narrative, exported as the cold-start fallback for
 * the stale-while-revalidate read in routes/predict.ts (no prior LLM read to
 * serve while the first generation is still running).
 */
export function statsAssist(model: Model, ctx?: AssistContext): Assist {
  return heuristic(model, ctx);
}

function heuristic(model: Model, ctx?: AssistContext): Assist {
  const { change24hPct, driftPerMin } = model.stats;
  const change = `${change24hPct >= 0 ? '+' : ''}${change24hPct.toFixed(2)}% on 24h`;
  const lead = ctx?.reads[0];
  if (lead && ctx) {
    const vs = ctx.price >= lead.strike ? 'above' : 'below';
    const strike = lead.strike.toLocaleString('en-US', {
      maximumFractionDigits: 0,
    });
    const narrative =
      `Leaning ${dirOf(lead.probUp)} on the ${lead.label} (${pct(lead.probUp)}%): ` +
      `spot ${vs} the $${strike} strike, drift ${(driftPerMin * 1e4).toFixed(2)}bp/min, ${change}.`;
    return { bias: 0, narrative, llmApplied: false };
  }
  const dir = driftPerMin > 0 ? 'upward' : 'downward';
  const asset = ctx?.asset?.split('/')[0] ?? 'BTC';
  const narrative = `Near-flat read: ${dir} 1m drift of ${(driftPerMin * 1e4).toFixed(2)}bp/min, ${asset} ${change}.`;
  return { bias: 0, narrative, llmApplied: false };
}

async function llmAssist(
  model: Model,
  llm: Parameters<typeof generateObject>[0]['model'],
  ctx?: AssistContext
): Promise<Assist> {
  const s = model.stats;
  // Compact prompt: terse stats + the model's own per-window calls (so the read
  // can cite concrete levels), no JSON-format instructions (the schema handles
  // shape). Fewer input tokens + grounded context = faster, sharper output.
  const reads = ctx
    ? `\nModel calls (price to beat = strike):\n${readLines(ctx)}`
    : '';
  const prompt =
    `${ctx?.asset ?? 'BTC/USDT'} $${s.price.toFixed(0)}, 24h ${s.change24hPct.toFixed(2)}%. ` +
    `drift ${(s.driftPerMin * 1e4).toFixed(2)}bp/min, ` +
    `vol/min ${(s.volPerMin * 100).toFixed(3)}%, ` +
    `vol/hr ${(s.volPerHour * 100).toFixed(2)}%.${reads}\n\n` +
    `Short-horizon moves are near-random; only show conviction when momentum and ` +
    `the level (spot vs strike) clearly agree, and keep bias small otherwise.\n` +
    `narrative: a punchy headline — ONE short sentence (under 120 characters) with ` +
    `the lean and the single key level. It must stand alone.\n` +
    `reasoning: a full trader's report in short paragraphs — the momentum/volatility ` +
    `read, each window's call with its level, where the market price disagrees with ` +
    `the model and why, and the main risk that would flip the lean. Cite concrete ` +
    `numbers throughout. No hedging or filler, and don't restate the raw stats.`;

  const { object } = await generateObject({
    model: llm,
    schema: AssistSchema,
    prompt,
    maxOutputTokens: 2048,
    temperature: 0.2,
    providerOptions: { lmstudio: { enable_thinking: false } },
  });

  return {
    bias: Math.max(-1, Math.min(1, object.bias)),
    narrative: object.narrative,
    reasoning: object.reasoning,
    llmApplied: true,
  };
}
