/** OpenAI-compatible chat completions. Works with DeepSeek and any compatible provider. */

export interface LlmConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  thinking: string;
}

export function llmConfig(): LlmConfig {
  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
  const baseURL = (process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.LLM_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const isDeepSeek = baseURL.includes('api.deepseek.com');
  const thinking = (process.env.LLM_THINKING || (isDeepSeek ? 'disabled' : '')).trim();
  return { apiKey, baseURL, model, thinking };
}

export function llmReady(): boolean {
  return Boolean(llmConfig().apiKey);
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LlmResult {
  content: string;
  toolCalls: ToolCall[];
}

/** Call the model. Returns text plus any tool calls the model requested. */
export async function callLlm(messages: ChatMessage[], tools?: unknown[]): Promise<LlmResult> {
  const { apiKey, baseURL, model, thinking } = llmConfig();
  if (!apiKey) throw new Error('未配置 LLM_API_KEY');

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.6,
    max_tokens: 2400,
  };
  if (thinking === 'enabled' || thinking === 'disabled') body.thinking = { type: thinking };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`模型请求失败 (${response.status})：${detail.slice(0, 300)}`);
  }
  const data = await response.json();
  const message = data.choices?.[0]?.message ?? {};
  return {
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
  };
}
