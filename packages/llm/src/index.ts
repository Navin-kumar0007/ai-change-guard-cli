export type ProviderId = "openai" | "anthropic" | "google" | "groq" | "openrouter" | "mistral" | "ollama";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ToolDef {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmResponse {
  text: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  servedModel?: string;
  finishReason?: string;
  refused: boolean;
}

export type LlmClient = (request: LlmRequest) => Promise<LlmResponse>;

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const OPENAI_COMPATIBLE: Record<string, { baseUrl: string; keyEnv?: string; tokenParam: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", tokenParam: "max_completion_tokens" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", tokenParam: "max_tokens" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", tokenParam: "max_tokens" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY", tokenParam: "max_tokens" },
  ollama: { baseUrl: "http://localhost:11434/v1", tokenParam: "max_tokens" },
};

const PROVIDERS = new Set<string>([...Object.keys(OPENAI_COMPATIBLE), "anthropic", "google"]);

export function parseModelRef(ref: string): { provider: ProviderId; model: string } {
  const at = ref.indexOf(":");
  const provider = at > 0 ? ref.slice(0, at) : "";
  const model = at > 0 ? ref.slice(at + 1) : "";
  if (!PROVIDERS.has(provider) || !model) {
    throw new LlmError(
      `"${ref}" is not a model reference. Use provider:model, e.g. openai:gpt-4o, anthropic:claude-sonnet-4-5, google:gemini-2.5-flash. Providers: ${[...PROVIDERS].join(", ")}.`,
    );
  }
  return { provider: provider as ProviderId, model };
}

const REFUSAL_RE =
  /^\s*(?:I'm sorry|I am sorry|Sorry,|I apologi[sz]e|I can't|I cannot|I can not|I'm unable|I am unable|I won't|I will not|I'm not able|I am not able)\b/i;

export function looksLikeRefusal(text: string): boolean {
  return REFUSAL_RE.test(text.slice(0, 200));
}

type Env = Record<string, string | undefined>;
type FetchFn = typeof fetch;
// Provider payloads are external JSON; they are read defensively below.
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ClientOptions {
  env?: Env;
  fetch?: FetchFn;
  timeoutMs?: number;
}

async function postJson(
  fetchFn: FetchFn,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<{ data: Json; latencyMs: number }> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new LlmError(`Network error: ${error instanceof Error ? error.message : String(error)}`, undefined, true);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new LlmError(
      `HTTP ${res.status}: ${providerMessage(text)}`,
      res.status,
      res.status === 429 || res.status >= 500,
      retryAfterMs(res.headers.get("retry-after"), text),
    );
  }
  try {
    return { data: JSON.parse(text), latencyMs: Date.now() - started };
  } catch {
    throw new LlmError("The provider returned a response that is not JSON.", res.status);
  }
}

function shorten(text: string): string {
  const firstLine = text.trim().split("\n")[0]!.trim();
  return firstLine.length > 200 ? `${firstLine.slice(0, 199).trimEnd()}…` : firstLine;
}

export function providerMessage(body: string): string {
  try {
    const data: Json = JSON.parse(body);
    const message = data?.error?.message ?? (typeof data?.error === "string" ? data.error : undefined) ?? data?.message;
    if (typeof message === "string" && message.trim()) return shorten(message);
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return shorten(body);
}

export function retryAfterMs(header: string | null, body: string): number | undefined {
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  try {
    const details: Json[] = JSON.parse(body)?.error?.details ?? [];
    const delay = details.find((d) => typeof d?.retryDelay === "string")?.retryDelay as string | undefined;
    const match = delay ? /^(\d+(?:\.\d+)?)s$/.exec(delay) : null;
    if (match) return Number(match[1]) * 1000;
  } catch {
    // No machine-readable retry hint.
  }
  return undefined;
}

function requireKey(env: Env, name: string): string {
  const key = env[name];
  if (!key) throw new LlmError(`Missing ${name}. Set it in your environment to call this provider.`);
  return key;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function callOpenAiCompatible(provider: string, req: LlmRequest, model: string, opts: Required<ClientOptions>) {
  const cfg = OPENAI_COMPATIBLE[provider]!;
  const baseUrl = opts.env[`${provider.toUpperCase()}_BASE_URL`] ?? cfg.baseUrl;
  const headers: Record<string, string> = {};
  if (cfg.keyEnv) headers.authorization = `Bearer ${requireKey(opts.env, cfg.keyEnv)}`;

  const messages = [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages];
  const body: Record<string, unknown> = { model, messages };
  if (req.maxTokens) body[cfg.tokenParam] = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.jsonMode) body.response_format = { type: "json_object" };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  const { data, latencyMs } = await postJson(opts.fetch, `${baseUrl}/chat/completions`, headers, body, opts.timeoutMs);
  const choice = data?.choices?.[0];
  const message = choice?.message ?? {};
  const text = typeof message.content === "string" ? message.content : "";
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((c: Json) => ({
    name: String(c?.function?.name ?? ""),
    arguments: parseArgs(c?.function?.arguments),
  }));
  return {
    text,
    toolCalls,
    inputTokens: Number(data?.usage?.prompt_tokens ?? 0),
    outputTokens: Number(data?.usage?.completion_tokens ?? 0),
    latencyMs,
    servedModel: typeof data?.model === "string" ? data.model : undefined,
    finishReason: choice?.finish_reason ?? undefined,
    refused: Boolean(message.refusal) || looksLikeRefusal(text),
  } satisfies LlmResponse;
}

async function callAnthropic(req: LlmRequest, model: string, opts: Required<ClientOptions>) {
  const headers = { "x-api-key": requireKey(opts.env, "ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" };
  const body: Record<string, unknown> = { model, max_tokens: req.maxTokens ?? 1024, messages: req.messages };
  if (req.system) body.system = req.system;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  const baseUrl = opts.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
  const { data, latencyMs } = await postJson(opts.fetch, `${baseUrl}/v1/messages`, headers, body, opts.timeoutMs);
  const blocks: Json[] = Array.isArray(data?.content) ? data.content : [];
  const text = blocks
    .filter((b) => b?.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("");
  const toolCalls = blocks
    .filter((b) => b?.type === "tool_use")
    .map((b) => ({ name: String(b.name ?? ""), arguments: parseArgs(b.input) }));
  return {
    text,
    toolCalls,
    inputTokens: Number(data?.usage?.input_tokens ?? 0),
    outputTokens: Number(data?.usage?.output_tokens ?? 0),
    latencyMs,
    servedModel: typeof data?.model === "string" ? data.model : undefined,
    finishReason: data?.stop_reason ?? undefined,
    refused: data?.stop_reason === "refusal" || looksLikeRefusal(text),
  } satisfies LlmResponse;
}

async function callGoogle(req: LlmRequest, model: string, opts: Required<ClientOptions>) {
  const key = opts.env.GEMINI_API_KEY ?? opts.env.GOOGLE_API_KEY;
  if (!key) throw new LlmError("Missing GEMINI_API_KEY (or GOOGLE_API_KEY). Set it in your environment to call Gemini.");
  const body: Record<string, unknown> = {
    contents: req.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
  };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  const generationConfig: Record<string, unknown> = {};
  if (req.maxTokens) generationConfig.maxOutputTokens = req.maxTokens;
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.jsonMode) generationConfig.responseMimeType = "application/json";
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
  if (req.tools?.length) {
    body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
  }
  const baseUrl = opts.env.GOOGLE_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta";
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
  const { data, latencyMs } = await postJson(opts.fetch, url, { "x-goog-api-key": key }, body, opts.timeoutMs);
  const candidate = data?.candidates?.[0];
  const parts: Json[] = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const text = parts
    .filter((p) => typeof p?.text === "string")
    .map((p) => p.text as string)
    .join("");
  const toolCalls = parts
    .filter((p) => p?.functionCall)
    .map((p) => ({ name: String(p.functionCall.name ?? ""), arguments: parseArgs(p.functionCall.args) }));
  const finishReason: string | undefined = candidate?.finishReason ?? data?.promptFeedback?.blockReason;
  return {
    text,
    toolCalls,
    inputTokens: Number(data?.usageMetadata?.promptTokenCount ?? 0),
    outputTokens: Number(data?.usageMetadata?.candidatesTokenCount ?? 0),
    latencyMs,
    servedModel: typeof data?.modelVersion === "string" ? data.modelVersion : undefined,
    finishReason,
    refused: finishReason === "SAFETY" || Boolean(data?.promptFeedback?.blockReason) || looksLikeRefusal(text),
  } satisfies LlmResponse;
}

export function createClient(options: ClientOptions = {}): LlmClient {
  const opts: Required<ClientOptions> = {
    env: options.env ?? process.env,
    fetch: options.fetch ?? fetch,
    timeoutMs: options.timeoutMs ?? 60_000,
  };
  return async (req) => {
    const { provider, model } = parseModelRef(req.model);
    if (provider === "anthropic") return callAnthropic(req, model, opts);
    if (provider === "google") return callGoogle(req, model, opts);
    return callOpenAiCompatible(provider, req, model, opts);
  };
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function withRetry(client: LlmClient, options: RetryOptions = {}): LlmClient {
  const retries = options.retries ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 60_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (req) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await client(req);
      } catch (error) {
        if (!(error instanceof LlmError) || !error.retryable || attempt >= retries) throw error;
        const backoff = baseDelayMs * 2 ** attempt;
        await sleep(Math.min(maxDelayMs, Math.max(backoff, error.retryAfterMs ?? 0)));
      }
    }
  };
}
