/**
 * Node-side model call for the agent (keeps the API key on the server / CLI machine).
 * Not exported from the package index; the server and CLI import this file directly.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ModelCall } from './agent.ts';

/** Credentials come from the environment (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile). */
export function anthropicModel(client: Anthropic = new Anthropic()): ModelCall {
  return async (params, onText, signal) => {
    const stream = client.beta.messages.stream(params, signal ? { signal } : undefined);
    stream.on('text', onText);
    return stream.finalMessage();
  };
}

/** True when some credential source is configured (best effort; the SDK has the final word). */
export function hasAnthropicCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE || env.ANTHROPIC_FEDERATION_RULE_ID);
}
