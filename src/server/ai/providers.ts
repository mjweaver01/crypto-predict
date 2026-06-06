import type { LanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export interface ModelProvider {
  id: string;
  name: string;
  /** Whether the required API key (if any) is present. */
  available: boolean;
  /** Human-readable key status shown at startup. */
  keyStatus: string;
  model: LanguageModel;
}

const hasKey = (key: string | undefined): boolean => Boolean(key);

const lmstudio = createOpenAICompatible({
  name: 'lmstudio',
  baseURL: process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1',
  // LM Studio requires response_format.type === 'json_schema' for structured
  // output (it rejects the default 'json_object' mode). This makes
  // generateObject send a real JSON Schema for grammar-constrained decoding.
  supportsStructuredOutputs: true,
});

/**
 * All supported models. Add new entries here; no other file needs touching.
 * Set LLM_MODEL in your environment to choose which one is active.
 */
export const MODEL_PROVIDERS: ModelProvider[] = [
  {
    id: 'gpt-4.1',
    name: 'GPT-4.1 (OpenAI)',
    available: hasKey(process.env.OPENAI_API_KEY),
    keyStatus: hasKey(process.env.OPENAI_API_KEY) ? 'key set' : 'no key',
    model: openai('gpt-4.1'),
  },
  {
    id: 'chat-latest',
    name: 'Chat Latest (OpenAI)',
    available: hasKey(process.env.OPENAI_API_KEY),
    keyStatus: hasKey(process.env.OPENAI_API_KEY) ? 'key set' : 'no key',
    model: openai('chat-latest'),
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5 (Anthropic)',
    available: hasKey(process.env.ANTHROPIC_API_KEY),
    keyStatus: hasKey(process.env.ANTHROPIC_API_KEY) ? 'key set' : 'no key',
    model: anthropic('claude-haiku-4-5-20251001'),
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6 (Anthropic)',
    available: hasKey(process.env.ANTHROPIC_API_KEY),
    keyStatus: hasKey(process.env.ANTHROPIC_API_KEY) ? 'key set' : 'no key',
    model: anthropic('claude-sonnet-4-6'),
  },
  {
    id: 'qwen/qwen3-4b',
    name: 'Qwen3.4B (LMStudio)',
    available: true,
    keyStatus: 'no key needed',
    model: lmstudio('qwen/qwen3-4b'),
  },

  {
    id: 'lmstudio/qwen3.5-9b',
    name: 'Qwen3.5-9B (LMStudio)',
    available: true,
    keyStatus: 'no key needed',
    model: lmstudio('qwen/qwen3.5-9b'),
  },
  {
    id: 'lmstudio/qwen3.6-35b',
    name: 'Qwen3.6-35B (LMStudio)',
    available: true,
    keyStatus: 'no key needed',
    model: lmstudio('qwen/qwen3.6-35b'),
  },
  {
    id: 'lmstudio/qwen3.6-35b-a3b',
    name: 'Qwen3.6-35B A3B (LMStudio)',
    available: true,
    keyStatus: 'no key needed',
    model: lmstudio('qwen/qwen3.6-35b-a3b'),
  },
  {
    id: 'lmstudio/huihui-gpt-oss-20b',
    name: 'Huihui GPT OSS 20B (LMStudio)',
    available: true,
    keyStatus: 'no key needed',
    model: lmstudio('huihui/huihui-gpt-oss-20b'),
  },
  {
    id: 'huihui-gpt-oss-20b-abliterated',
    name: 'Huihui GPT OSS 20B Abliterated (LMStudio)',
    available: true,
    keyStatus: 'no key needed',
    model: lmstudio('huihui-gpt-oss-20b-abliterated'),
  },
];

/**
 * The active model, resolved from the LLM_MODEL env var.
 * Falls back to the first available provider.
 */
export function getActiveModel(): LanguageModel {
  const targetId = process.env.LLM_MODEL;

  if (targetId) {
    const provider = MODEL_PROVIDERS.find(p => p.id === targetId);
    if (!provider) {
      throw new Error(
        `[ai/providers] LLM_MODEL="${targetId}" is not in the provider list. ` +
          `Available: ${MODEL_PROVIDERS.map(p => p.id).join(', ')}`
      );
    }
    if (!provider.available) {
      throw new Error(
        `[ai/providers] LLM_MODEL="${targetId}" requires an API key that is not set.`
      );
    }
    console.log(
      `[ai/providers] model: ${provider.name} — ${provider.keyStatus}`
    );
    return provider.model;
  }

  // No explicit selection — pick first available.
  const fallback = MODEL_PROVIDERS.find(p => p.available);
  if (!fallback) {
    throw new Error(
      '[ai/providers] No available AI provider. Set LLM_MODEL + a key, or point LMSTUDIO_BASE_URL at a running local server.'
    );
  }

  console.log(
    `[ai/providers] LLM_MODEL not set — using fallback: ${fallback.name} — ${fallback.keyStatus}`
  );
  return fallback.model;
}
