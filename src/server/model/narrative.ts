// Server wrapper — core logic lives in shared so the live client can mirror it.

import type { Model } from './forecast.ts';
import {
  buildNarrative as build,
  type NarrativeContext,
  type WindowRead,
} from '../../shared/narrative.ts';

export type { NarrativeContext, WindowRead };

/** The dashboard's one-sentence model read (defaults to the shortest horizon). */
export function buildNarrative(model: Model, ctx?: NarrativeContext): string {
  return build(model.stats, ctx);
}
