// action/src/main.ts
import { appendFile } from "node:fs/promises";
import { relative as relative2, resolve, sep as sep2 } from "node:path";

// packages/llm/dist/index.js
var LlmError = class extends Error {
  status;
  retryable;
  retryAfterMs;
  constructor(message, status, retryable = false, retryAfterMs2) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs2;
  }
};
var OPENAI_COMPATIBLE = {
  openai: { baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", tokenParam: "max_completion_tokens" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", tokenParam: "max_tokens" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", tokenParam: "max_tokens" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY", tokenParam: "max_tokens" },
  ollama: { baseUrl: "http://localhost:11434/v1", tokenParam: "max_tokens" }
};
var PROVIDERS = /* @__PURE__ */ new Set([...Object.keys(OPENAI_COMPATIBLE), "anthropic", "google"]);
function parseModelRef(ref) {
  const at = ref.indexOf(":");
  const provider = at > 0 ? ref.slice(0, at) : "";
  const model = at > 0 ? ref.slice(at + 1) : "";
  if (!PROVIDERS.has(provider) || !model) {
    throw new LlmError(`"${ref}" is not a model reference. Use provider:model, e.g. openai:gpt-4o, anthropic:claude-sonnet-4-5, google:gemini-2.5-flash. Providers: ${[...PROVIDERS].join(", ")}.`);
  }
  return { provider, model };
}
var REFUSAL_RE = /^\s*(?:I'm sorry|I am sorry|Sorry,|I apologi[sz]e|I can't|I cannot|I can not|I'm unable|I am unable|I won't|I will not|I'm not able|I am not able)\b/i;
function looksLikeRefusal(text) {
  return REFUSAL_RE.test(text.slice(0, 200));
}
async function postJson(fetchFn, url, headers, body, timeoutMs) {
  const started = Date.now();
  let res;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new LlmError(`Network error: ${error instanceof Error ? error.message : String(error)}`, void 0, true);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new LlmError(`HTTP ${res.status}: ${providerMessage(text)}`, res.status, res.status === 429 || res.status >= 500, retryAfterMs(res.headers.get("retry-after"), text));
  }
  try {
    return { data: JSON.parse(text), latencyMs: Date.now() - started };
  } catch {
    throw new LlmError("The provider returned a response that is not JSON.", res.status);
  }
}
function shorten(text) {
  const firstLine = text.trim().split("\n")[0].trim();
  return firstLine.length > 200 ? `${firstLine.slice(0, 199).trimEnd()}\u2026` : firstLine;
}
function providerMessage(body) {
  try {
    const data = JSON.parse(body);
    const message = data?.error?.message ?? (typeof data?.error === "string" ? data.error : void 0) ?? data?.message;
    if (typeof message === "string" && message.trim())
      return shorten(message);
  } catch {
  }
  return shorten(body);
}
function retryAfterMs(header, body) {
  const seconds2 = header ? Number(header) : NaN;
  if (Number.isFinite(seconds2) && seconds2 >= 0)
    return seconds2 * 1e3;
  try {
    const details = JSON.parse(body)?.error?.details ?? [];
    const delay = details.find((d) => typeof d?.retryDelay === "string")?.retryDelay;
    const match = delay ? /^(\d+(?:\.\d+)?)s$/.exec(delay) : null;
    if (match)
      return Number(match[1]) * 1e3;
  } catch {
  }
  return void 0;
}
function requireKey(env, name) {
  const key = env[name];
  if (!key)
    throw new LlmError(`Missing ${name}. Set it in your environment to call this provider.`);
  return key;
}
function parseArgs(raw) {
  if (raw && typeof raw === "object")
    return raw;
  if (typeof raw !== "string" || !raw.trim())
    return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
async function callOpenAiCompatible(provider, req, model, opts) {
  const cfg = OPENAI_COMPATIBLE[provider];
  const baseUrl = opts.env[`${provider.toUpperCase()}_BASE_URL`] ?? cfg.baseUrl;
  const headers = {};
  if (cfg.keyEnv)
    headers.authorization = `Bearer ${requireKey(opts.env, cfg.keyEnv)}`;
  const messages = [...req.system ? [{ role: "system", content: req.system }] : [], ...req.messages];
  const body = { model, messages };
  if (req.maxTokens)
    body[cfg.tokenParam] = req.maxTokens;
  if (req.temperature !== void 0)
    body.temperature = req.temperature;
  if (req.jsonMode)
    body.response_format = { type: "json_object" };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
  }
  const { data, latencyMs } = await postJson(opts.fetch, `${baseUrl}/chat/completions`, headers, body, opts.timeoutMs);
  const choice = data?.choices?.[0];
  const message = choice?.message ?? {};
  const text = typeof message.content === "string" ? message.content : "";
  const toolCalls = (message.tool_calls ?? []).map((c) => ({
    name: String(c?.function?.name ?? ""),
    arguments: parseArgs(c?.function?.arguments)
  }));
  return {
    text,
    toolCalls,
    inputTokens: Number(data?.usage?.prompt_tokens ?? 0),
    outputTokens: Number(data?.usage?.completion_tokens ?? 0),
    latencyMs,
    servedModel: typeof data?.model === "string" ? data.model : void 0,
    finishReason: choice?.finish_reason ?? void 0,
    refused: Boolean(message.refusal) || looksLikeRefusal(text)
  };
}
async function callAnthropic(req, model, opts) {
  const headers = { "x-api-key": requireKey(opts.env, "ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" };
  const body = { model, max_tokens: req.maxTokens ?? 1024, messages: req.messages };
  if (req.system)
    body.system = req.system;
  if (req.temperature !== void 0)
    body.temperature = req.temperature;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  const baseUrl = opts.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
  const { data, latencyMs } = await postJson(opts.fetch, `${baseUrl}/v1/messages`, headers, body, opts.timeoutMs);
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("");
  const toolCalls = blocks.filter((b) => b?.type === "tool_use").map((b) => ({ name: String(b.name ?? ""), arguments: parseArgs(b.input) }));
  return {
    text,
    toolCalls,
    inputTokens: Number(data?.usage?.input_tokens ?? 0),
    outputTokens: Number(data?.usage?.output_tokens ?? 0),
    latencyMs,
    servedModel: typeof data?.model === "string" ? data.model : void 0,
    finishReason: data?.stop_reason ?? void 0,
    refused: data?.stop_reason === "refusal" || looksLikeRefusal(text)
  };
}
async function callGoogle(req, model, opts) {
  const key = opts.env.GEMINI_API_KEY ?? opts.env.GOOGLE_API_KEY;
  if (!key)
    throw new LlmError("Missing GEMINI_API_KEY (or GOOGLE_API_KEY). Set it in your environment to call Gemini.");
  const body = {
    contents: req.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }))
  };
  if (req.system)
    body.systemInstruction = { parts: [{ text: req.system }] };
  const generationConfig = {};
  if (req.maxTokens)
    generationConfig.maxOutputTokens = req.maxTokens;
  if (req.temperature !== void 0)
    generationConfig.temperature = req.temperature;
  if (req.jsonMode)
    generationConfig.responseMimeType = "application/json";
  if (Object.keys(generationConfig).length > 0)
    body.generationConfig = generationConfig;
  if (req.tools?.length) {
    body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
  }
  const baseUrl = opts.env.GOOGLE_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta";
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
  const { data, latencyMs } = await postJson(opts.fetch, url, { "x-goog-api-key": key }, body, opts.timeoutMs);
  const candidate = data?.candidates?.[0];
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const text = parts.filter((p) => typeof p?.text === "string").map((p) => p.text).join("");
  const toolCalls = parts.filter((p) => p?.functionCall).map((p) => ({ name: String(p.functionCall.name ?? ""), arguments: parseArgs(p.functionCall.args) }));
  const finishReason = candidate?.finishReason ?? data?.promptFeedback?.blockReason;
  return {
    text,
    toolCalls,
    inputTokens: Number(data?.usageMetadata?.promptTokenCount ?? 0),
    outputTokens: Number(data?.usageMetadata?.candidatesTokenCount ?? 0),
    latencyMs,
    servedModel: typeof data?.modelVersion === "string" ? data.modelVersion : void 0,
    finishReason,
    refused: finishReason === "SAFETY" || Boolean(data?.promptFeedback?.blockReason) || looksLikeRefusal(text)
  };
}
function createClient(options = {}) {
  const opts = {
    env: options.env ?? process.env,
    fetch: options.fetch ?? fetch,
    timeoutMs: options.timeoutMs ?? 6e4
  };
  return async (req) => {
    const { provider, model } = parseModelRef(req.model);
    if (provider === "anthropic")
      return callAnthropic(req, model, opts);
    if (provider === "google")
      return callGoogle(req, model, opts);
    return callOpenAiCompatible(provider, req, model, opts);
  };
}
function withRetry(client, options = {}) {
  const retries = options.retries ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 1e3;
  const maxDelayMs = options.maxDelayMs ?? 6e4;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve2) => setTimeout(resolve2, ms)));
  return async (req) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await client(req);
      } catch (error) {
        if (!(error instanceof LlmError) || !error.retryable || attempt >= retries)
          throw error;
        const backoff = baseDelayMs * 2 ** attempt;
        await sleep(Math.min(maxDelayMs, Math.max(backoff, error.retryAfterMs ?? 0)));
      }
    }
  };
}

// packages/replay/dist/golden.js
import { readFile } from "node:fs/promises";
var GoldenSetError = class extends Error {
};
function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function parseMessages(raw, where) {
  if (typeof raw.input === "string" && raw.input.trim())
    return [{ role: "user", content: raw.input }];
  const list = raw.messages;
  if (Array.isArray(list) && list.length > 0) {
    const messages = list.map((m, i) => {
      if (!isObject(m) || m.role !== "user" && m.role !== "assistant" || typeof m.content !== "string") {
        throw new GoldenSetError(`${where}: messages[${i}] needs a role of "user" or "assistant" and text content`);
      }
      return { role: m.role, content: m.content };
    });
    if (messages.at(-1)?.role !== "user")
      throw new GoldenSetError(`${where}: the last message must be from the user`);
    return messages;
  }
  throw new GoldenSetError(`${where}: needs "input" (text) or "messages" (a list of {role, content})`);
}
function parseTools(raw, where) {
  if (raw === void 0)
    return void 0;
  if (!Array.isArray(raw))
    throw new GoldenSetError(`${where}: "tools" must be a list`);
  return raw.map((t, i) => {
    if (!isObject(t) || typeof t.name !== "string" || !isObject(t.parameters)) {
      throw new GoldenSetError(`${where}: tools[${i}] needs a "name" and a "parameters" JSON schema`);
    }
    const tool = { name: t.name, parameters: t.parameters };
    if (typeof t.description === "string")
      tool.description = t.description;
    return tool;
  });
}
function parseExpect(raw, where) {
  if (raw === void 0)
    return void 0;
  if (!isObject(raw))
    throw new GoldenSetError(`${where}: "expect" must be an object`);
  const expect = {};
  if (raw.json !== void 0)
    expect.json = Boolean(raw.json);
  if (raw.schema !== void 0) {
    if (!isObject(raw.schema))
      throw new GoldenSetError(`${where}: "expect.schema" must be a JSON schema object`);
    expect.schema = raw.schema;
  }
  if (raw.tool !== void 0) {
    if (typeof raw.tool !== "string")
      throw new GoldenSetError(`${where}: "expect.tool" must be a tool name`);
    expect.tool = raw.tool;
  }
  if (raw.contains !== void 0) {
    if (!Array.isArray(raw.contains) || !raw.contains.every((s) => typeof s === "string")) {
      throw new GoldenSetError(`${where}: "expect.contains" must be a list of text`);
    }
    expect.contains = raw.contains;
  }
  return expect;
}
function parseGoldenSet(text) {
  const items = [];
  const ids = /* @__PURE__ */ new Set();
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("//"))
      return;
    const where = `Line ${index + 1}`;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new GoldenSetError(`${where}: not valid JSON`);
    }
    if (!isObject(raw))
      throw new GoldenSetError(`${where}: each line must be a JSON object`);
    const id = raw.id === void 0 ? `line-${index + 1}` : String(raw.id);
    if (ids.has(id))
      throw new GoldenSetError(`${where}: duplicate id "${id}"`);
    ids.add(id);
    if (raw.system !== void 0 && typeof raw.system !== "string")
      throw new GoldenSetError(`${where}: "system" must be text`);
    const item = { id, messages: parseMessages(raw, where) };
    if (typeof raw.system === "string")
      item.system = raw.system;
    const tools = parseTools(raw.tools, where);
    if (tools)
      item.tools = tools;
    const expect = parseExpect(raw.expect, where);
    if (expect)
      item.expect = expect;
    if (typeof raw.max_tokens === "number")
      item.maxTokens = raw.max_tokens;
    if (typeof raw.temperature === "number")
      item.temperature = raw.temperature;
    if (raw.json_mode === true)
      item.jsonMode = true;
    items.push(item);
  });
  if (items.length === 0)
    throw new GoldenSetError("The golden set is empty.");
  return items;
}
async function loadGoldenSet(path) {
  return parseGoldenSet(await readFile(path, "utf8"));
}

// packages/replay/dist/schema.js
function typeOf(value) {
  if (value === null)
    return "null";
  if (Array.isArray(value))
    return "array";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}
function matchesType(value, type) {
  const actual = typeOf(value);
  return actual === type || type === "number" && actual === "integer";
}
function validateSchema(value, schema, path = "$") {
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t)))
      return [`${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`];
  }
  const errors = [];
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: not one of the allowed values`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== void 0 && value.length < schema.minLength)
      errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== void 0 && value.length > schema.maxLength)
      errors.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== void 0 && value < schema.minimum)
      errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== void 0 && value > schema.maximum)
      errors.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== void 0 && value.length < schema.minItems)
      errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== void 0 && value.length > schema.maxItems)
      errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items)
      value.forEach((v, i) => errors.push(...validateSchema(v, schema.items, `${path}[${i}]`)));
  }
  if (typeOf(value) === "object") {
    const obj = value;
    for (const key of schema.required ?? [])
      if (!(key in obj))
        errors.push(`${path}: missing "${key}"`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj)
        errors.push(...validateSchema(obj[key], sub, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!schema.properties || !(key in schema.properties))
          errors.push(`${path}: unexpected "${key}"`);
      }
    }
  }
  return errors;
}
function extractJson(text) {
  let candidate = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(candidate);
  if (fenced?.[1] !== void 0)
    candidate = fenced[1];
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch {
    return { ok: false };
  }
}

// packages/replay/dist/similarity.js
function termVector(text) {
  const vector = /* @__PURE__ */ new Map();
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    vector.set(word, (vector.get(word) ?? 0) + 1);
  return vector;
}
function norm(vector) {
  let sum = 0;
  for (const count2 of vector.values())
    sum += count2 * count2;
  return Math.sqrt(sum);
}
function similarity(a, b) {
  if (!a.trim() && !b.trim())
    return 1;
  const va = termVector(a);
  const vb = termVector(b);
  let dot = 0;
  for (const [word, count2] of va)
    dot += count2 * (vb.get(word) ?? 0);
  const denominator = norm(va) * norm(vb);
  return denominator === 0 ? 0 : dot / denominator;
}

// packages/replay/dist/run.js
var SpendCapError = class extends Error {
};
var ReplayCancelledError = class extends Error {
};
function plannedCalls(items, runs, sides = 2) {
  return items * runs * sides;
}
function requestFor(item, model, defaultMaxTokens) {
  const request = { model, messages: item.messages, maxTokens: item.maxTokens ?? defaultMaxTokens };
  if (item.system)
    request.system = item.system;
  if (item.tools)
    request.tools = item.tools;
  if (item.temperature !== void 0)
    request.temperature = item.temperature;
  if (item.jsonMode)
    request.jsonMode = true;
  return request;
}
async function runReplay(options) {
  const runs = options.runs ?? 5;
  const concurrency = Math.max(1, options.concurrency ?? 5);
  const maxCalls = options.maxCalls ?? 500;
  const sides = options.sides ?? ["old", "new"];
  const total = plannedCalls(options.items.length, runs, sides.length);
  if (total > maxCalls) {
    throw new SpendCapError(`This replay needs ${total} AI calls, above the limit of ${maxCalls}. Lower --runs, use fewer prompts, or raise --max-calls.`);
  }
  const tasks = [];
  for (const item of options.items) {
    for (let run2 = 0; run2 < runs; run2++) {
      for (const side of sides) {
        const request = requestFor(item, side === "old" ? options.oldModel : options.newModel, options.defaultMaxTokens ?? 1024);
        tasks.push(async () => {
          try {
            return { itemId: item.id, side, run: run2, response: await options.client(request) };
          } catch (error) {
            return { itemId: item.id, side, run: run2, error: error instanceof Error ? error.message : String(error) };
          }
        });
      }
    }
  }
  const results = new Array(tasks.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < tasks.length && !options.signal?.aborted) {
      const index = next++;
      results[index] = await tasks[index]();
      done++;
      options.onProgress?.(done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  if (options.signal?.aborted)
    throw new ReplayCancelledError(`Replay cancelled after ${done} of ${total} calls.`);
  return results;
}

// packages/replay/dist/verdict.js
var average = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
var atLeast = (n, fraction) => Math.max(1, Math.ceil(n * fraction));
var count = (responses, test) => responses.filter(test).length;
function sideStats(records) {
  const ok = records.flatMap((r) => r.response ? [r.response] : []);
  return {
    runs: records.length,
    errors: records.length - ok.length,
    avgInputTokens: average(ok.map((r) => r.inputTokens)),
    avgOutputTokens: average(ok.map((r) => r.outputTokens)),
    avgLatencyMs: average(ok.map((r) => r.latencyMs)),
    avgChars: average(ok.map((r) => r.text.length)),
    servedModels: [...new Set(ok.flatMap((r) => r.servedModel ? [r.servedModel] : []))]
  };
}
function mostCommon(values) {
  const counts = /* @__PURE__ */ new Map();
  for (const v of values)
    counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = { value: "", share: 0 };
  for (const [value, n] of counts)
    if (n / values.length > best.share)
      best = { value, share: n / values.length };
  return best;
}
function missingRequiredArg(item, call) {
  const required = item.tools?.find((t) => t.name === call.name)?.parameters.required;
  if (!Array.isArray(required))
    return false;
  return required.some((key) => typeof key === "string" && !(key in call.arguments));
}
function firstError(records) {
  return records.find((r) => r.error)?.error ?? "no runs";
}
function judgeItem(item, records) {
  const oldRecords = records.filter((r) => r.itemId === item.id && r.side === "old");
  const newRecords = records.filter((r) => r.itemId === item.id && r.side === "new");
  const oldOk = oldRecords.flatMap((r) => r.response ? [r.response] : []);
  const newOk = newRecords.flatMap((r) => r.response ? [r.response] : []);
  const result = { id: item.id, verdict: "same", reasons: [], old: sideStats(oldRecords), new: sideStats(newRecords) };
  if (oldOk[0])
    result.sampleOld = oldOk[0].text;
  if (newOk[0])
    result.sampleNew = newOk[0].text;
  const add = (code3, severity, detail) => result.reasons.push({ code: code3, severity, detail });
  if (oldOk.length === 0) {
    result.verdict = "error";
    const oldError = firstError(oldRecords);
    const newStatus = newOk.length > 0 ? `The new model answered ${newOk.length} of ${newRecords.length} times.` : firstError(newRecords) === oldError ? "The new model failed the same way." : `The new model failed too: ${firstError(newRecords)}`;
    result.error = `The old model never answered: ${oldError} \u2014 ${newStatus}`;
    return result;
  }
  if (newOk.length === 0) {
    add("calls-failing", "broken", `All ${newRecords.length} calls to the new model failed: ${firstError(newRecords)}`);
    result.verdict = "broken";
    return result;
  }
  const newErrors = newRecords.length - newOk.length;
  if (newErrors >= atLeast(newRecords.length, 0.4)) {
    add("calls-failing", "broken", `${newErrors} of ${newRecords.length} calls to the new model failed: ${firstError(newRecords)}`);
  }
  const threshold = atLeast(newOk.length, 0.4);
  const expect = item.expect;
  if (expect?.json || expect?.schema) {
    const problem = (r) => {
      const parsed = extractJson(r.text);
      if (!parsed.ok)
        return "not valid JSON";
      return expect.schema ? validateSchema(parsed.value, expect.schema)[0] ?? null : null;
    };
    const newBad = count(newOk, (r) => problem(r) !== null);
    const oldBad = count(oldOk, (r) => problem(r) !== null);
    if (newBad >= threshold && newBad > oldBad) {
      const example = newOk.map(problem).find((p) => p !== null);
      add("format-broken", "broken", `${newBad} of ${newOk.length} new answers fail the expected ${expect.schema ? "JSON schema" : "JSON format"} (old: ${oldBad} of ${oldOk.length}). First problem: ${example}`);
    }
  }
  if (expect?.tool) {
    const wrong = (r) => !r.toolCalls.some((c) => c.name === expect.tool);
    const newWrong = count(newOk, wrong);
    const oldWrong = count(oldOk, wrong);
    if (newWrong >= threshold && newWrong > oldWrong) {
      add("tool-change", "broken", `${newWrong} of ${newOk.length} new answers don't call ${expect.tool} (old: ${oldWrong} of ${oldOk.length})`);
    }
  } else if (item.tools?.length) {
    const firstTool = (r) => r.toolCalls[0]?.name ?? "no tool";
    const oldMode = mostCommon(oldOk.map(firstTool));
    const newMode = mostCommon(newOk.map(firstTool));
    if (oldMode.share >= 0.6 && newMode.share >= 0.6 && oldMode.value !== newMode.value) {
      add("tool-change", "broken", `The old model called ${oldMode.value}; the new one calls ${newMode.value}`);
    }
  }
  if (item.tools?.length) {
    const missing = (r) => r.toolCalls.some((c) => missingRequiredArg(item, c));
    const newMissing = count(newOk, missing);
    const oldMissing = count(oldOk, missing);
    if (newMissing >= threshold && newMissing > oldMissing) {
      add("tool-args-missing", "broken", `${newMissing} of ${newOk.length} new tool calls miss a required argument (old: ${oldMissing} of ${oldOk.length})`);
    }
  }
  if (expect?.contains?.length) {
    const wanted = expect.contains;
    const lacks = (r) => wanted.some((s) => !r.text.toLowerCase().includes(s.toLowerCase()));
    const newLacks = count(newOk, lacks);
    const oldLacks = count(oldOk, lacks);
    if (newLacks >= threshold && newLacks > oldLacks) {
      add("missing-text", "broken", `${newLacks} of ${newOk.length} new answers miss required text: ${wanted.join(", ")} (old: ${oldLacks} of ${oldOk.length})`);
    }
  }
  const newRefusals = count(newOk, (r) => r.refused);
  const oldRefusals = count(oldOk, (r) => r.refused);
  const refusalChange = newRefusals >= atLeast(newOk.length, 0.6) && oldRefusals <= Math.floor(oldOk.length * 0.2);
  if (refusalChange) {
    add("new-refusal", "changed", `The new model refused ${newRefusals} of ${newOk.length} times (old: ${oldRefusals} of ${oldOk.length})`);
  }
  const oldTexts = oldOk.map((r) => r.text).filter((t) => t.trim());
  const newTexts = newOk.map((r) => r.text).filter((t) => t.trim());
  if (!refusalChange && oldTexts.length > 1 && newTexts.length > 0) {
    const pairs = [];
    for (let i = 0; i < oldTexts.length; i++) {
      for (let j = i + 1; j < oldTexts.length; j++)
        pairs.push(similarity(oldTexts[i], oldTexts[j]));
    }
    const oldSelf = average(pairs);
    const cross = newTexts.map((t) => Math.max(...oldTexts.map((o) => similarity(t, o))));
    const drifted = cross.filter((c) => c < oldSelf * 0.7).length;
    if (drifted >= atLeast(newTexts.length, 0.6)) {
      add("answer-drift", "changed", `${drifted} of ${newTexts.length} new answers read differently from the old ones (word overlap ${average(cross).toFixed(2)} vs ${oldSelf.toFixed(2)} between old answers; approximate)`);
    }
  }
  result.verdict = result.reasons.some((r) => r.severity === "broken") ? "broken" : result.reasons.length > 0 ? "changed" : "same";
  return result;
}

// packages/replay/dist/report.js
var VERDICT_ORDER = { broken: 0, changed: 1, error: 2, same: 3 };
var average2 = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
function modelName(ref) {
  return ref.slice(ref.indexOf(":") + 1);
}
function lastSegment(name) {
  return (name.split("/").at(-1) ?? name).toLowerCase();
}
function isReroute(requested, served) {
  const a = lastSegment(requested);
  const b = lastSegment(served);
  return !b.startsWith(a) && !a.startsWith(b);
}
function buildReplayReport(items, records, options) {
  const results = items.map((item) => judgeItem(item, records)).sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict]);
  const totals = { same: 0, changed: 0, broken: 0, error: 0 };
  for (const r of results)
    totals[r.verdict]++;
  const ok = (side) => records.flatMap((r) => r.side === side && r.response ? [r.response] : []);
  const paired = results.filter((r) => r.old.runs > r.old.errors && r.new.runs > r.new.errors);
  const usage = (side) => ({
    input: average2(paired.map((r) => r[side].avgInputTokens)),
    output: average2(paired.map((r) => r[side].avgOutputTokens))
  });
  const reroutes = [];
  for (const side of ["old", "new"]) {
    const requested = modelName(side === "old" ? options.oldModel : options.newModel);
    const served = new Set(ok(side).flatMap((r) => r.servedModel ? [r.servedModel] : []));
    for (const s of served)
      if (isReroute(requested, s))
        reroutes.push({ side, requested, served: s });
  }
  return {
    oldModel: options.oldModel,
    newModel: options.newModel,
    runs: options.runs,
    calls: records.length,
    failedCalls: records.filter((r) => r.error).length,
    totals,
    avgTokens: { old: usage("old"), new: usage("new") },
    avgLatencyMs: { old: average2(paired.map((r) => r.old.avgLatencyMs)), new: average2(paired.map((r) => r.new.avgLatencyMs)) },
    comparedPrompts: paired.length,
    rateLimited: records.some((r) => r.error?.startsWith("HTTP 429")),
    reroutes,
    items: results
  };
}
function change(before, after) {
  if (before === 0)
    return "";
  const pct = Math.round((after - before) / before * 100);
  return ` (${pct > 0 ? "+" : ""}${pct}%)`;
}
function seconds(ms) {
  return `${(ms / 1e3).toFixed(1)} s`;
}
function formatReplayMarkdown(report) {
  const t = report.totals;
  const o = report.avgTokens.old;
  const n = report.avgTokens.new;
  const out = [
    `## Model switch check: \`${report.oldModel}\` \u2192 \`${report.newModel}\``,
    "",
    `${report.items.length} real prompt${report.items.length === 1 ? "" : "s"}, ${report.runs} run${report.runs === 1 ? "" : "s"} each on both models.`,
    "",
    "| Same | Changed | Broken | Could not compare |",
    "| --- | --- | --- | --- |",
    `| ${t.same} | ${t.changed} | ${t.broken} | ${t.error} |`,
    "",
    `Per call: input tokens ${Math.round(o.input)} \u2192 ${Math.round(n.input)}${change(o.input, n.input)}, output tokens ${Math.round(o.output)} \u2192 ${Math.round(n.output)}${change(o.output, n.output)}, latency ${seconds(report.avgLatencyMs.old)} \u2192 ${seconds(report.avgLatencyMs.new)}.`
  ];
  for (const r of report.reroutes)
    out.push("", `> **Note:** the ${r.side} model \`${r.requested}\` was answered by \`${r.served}\`.`);
  const flagged = report.items.filter((i) => i.verdict !== "same");
  if (flagged.length > 0) {
    out.push("", "### What changed");
    for (const item of flagged) {
      out.push("", `**${item.verdict.toUpperCase()}: ${item.id}**`);
      if (item.error)
        out.push(`- ${item.error}`);
      for (const reason of item.reasons)
        out.push(`- ${reason.detail}`);
    }
  }
  return out.join("\n");
}

// packages/replay/dist/repair.js
var MAX_SCHEMA_CHARS = 2e3;
var NO_JSON_MODE = /* @__PURE__ */ new Set(["anthropic"]);
function repairable(result) {
  const broken = result.reasons.filter((r) => r.severity === "broken");
  return result.verdict === "broken" && broken.length > 0 && broken.every((r) => r.code === "format-broken");
}
function formatInstruction(item) {
  const base = "Answer with one JSON value only: no explanation before or after it, no Markdown, no code fences.";
  if (!item.expect?.schema)
    return base;
  const schema = JSON.stringify(item.expect.schema);
  return schema.length <= MAX_SCHEMA_CHARS ? `${base} It must match this JSON Schema: ${schema}` : base;
}
function cell(text) {
  return text.replace(/\s+/g, " ").replace(/\|/g, "\\|");
}
function code(text) {
  return "`" + text.replace(/\s+/g, " ").replace(/`/g, "'") + "`";
}
function candidates(item, newModel) {
  const systemAddition = formatInstruction(item);
  const list = [{ kind: "format-instruction", systemAddition }];
  if (!item.jsonMode && !item.tools?.length && !NO_JSON_MODE.has(parseModelRef(newModel).provider)) {
    list.push({ kind: "json-mode", systemAddition, jsonMode: true });
  }
  return list;
}
function applyRepair(item, patch) {
  const repaired = { ...item, system: item.system ? `${item.system}

${patch.systemAddition}` : patch.systemAddition };
  if (patch.jsonMode)
    repaired.jsonMode = true;
  return repaired;
}
function plannedRepairCalls(items, results, newModel, runs) {
  const byId = new Map(items.map((i) => [i.id, i]));
  return results.filter(repairable).reduce((sum, r) => sum + candidates(byId.get(r.id), newModel).length * runs, 0);
}
async function runRepair(options) {
  const { items, newModel, runs } = options;
  const byId = new Map(items.map((i) => [i.id, i]));
  const targets = options.results.filter(repairable).map((r) => ({ item: byId.get(r.id), tries: candidates(byId.get(r.id), newModel) }));
  const maxCalls = options.maxCalls ?? 500;
  const planned = targets.reduce((sum, t) => sum + t.tries.length * runs, 0);
  if (planned > maxCalls) {
    throw new SpendCapError(`Prompt Repair could need ${planned} AI calls, above the limit of ${maxCalls}. Lower the runs or raise the limit.`);
  }
  const results = new Map(targets.map((t) => [t.item.id, { id: t.item.id, fixed: false, attempts: [] }]));
  const oldRecords = options.records.filter((r) => r.side === "old");
  let calls = 0;
  const rounds = Math.max(0, ...targets.map((t) => t.tries.length));
  for (let round = 0; round < rounds; round++) {
    const batch = targets.flatMap((t) => {
      const patch = t.tries[round];
      return patch && !results.get(t.item.id).fixed ? [{ original: t.item, patch, repaired: applyRepair(t.item, patch) }] : [];
    });
    if (batch.length === 0)
      break;
    const records = await runReplay({
      items: batch.map((b) => b.repaired),
      // Only the new model is called (sides); the old model's answers come from the replay.
      oldModel: newModel,
      newModel,
      client: options.client,
      runs,
      ...options.concurrency ? { concurrency: options.concurrency } : {},
      maxCalls: maxCalls - calls,
      sides: ["new"],
      ...options.signal ? { signal: options.signal } : {}
    });
    calls += records.length;
    const reference = [...oldRecords, ...records];
    for (const b of batch) {
      const judged = judgeItem(b.repaired, reference);
      const fixed = judged.verdict !== "broken";
      const format = judged.reasons.find((r) => r.code === "format-broken");
      const result = results.get(b.original.id);
      result.attempts.push({
        kind: b.patch.kind,
        fixed,
        detail: fixed ? `passes now (verdict: ${judged.verdict}, ${judged.new.runs - judged.new.errors} of ${judged.new.runs} calls answered)` : format?.detail ?? judged.reasons.find((r) => r.severity === "broken")?.detail ?? "still broken"
      });
      if (fixed) {
        result.fixed = true;
        result.patch = b.patch;
      }
    }
  }
  return { newModel, runs, calls, results: [...results.values()] };
}
var KIND_LABEL = {
  "format-instruction": "JSON-only instruction added to the system prompt",
  "json-mode": "JSON-only instruction plus the provider's JSON mode"
};
function formatRepairMarkdown(report) {
  if (report.results.length === 0)
    return "";
  const fixed = report.results.filter((r) => r.fixed);
  const lines = [
    "### Prompt Repair",
    "",
    `${fixed.length} of ${report.results.length} prompt${report.results.length === 1 ? "" : "s"} with a broken answer format fixed on \`${report.newModel}\` (${report.calls} extra calls, ${report.runs} run${report.runs === 1 ? "" : "s"} per try).`,
    "",
    "| Prompt | Result | Tried |",
    "| --- | --- | --- |",
    ...report.results.map((r) => `| ${cell(r.id)} | ${r.fixed ? `Fixed: ${KIND_LABEL[r.patch.kind]}` : "Not fixed"} | ${r.attempts.map((a) => cell(`${a.kind}: ${a.detail}`)).join("<br>")} |`)
  ];
  for (const r of fixed) {
    lines.push("", `**Change for ${code(r.id)}:** add this to the end of the system prompt${r.patch.jsonMode ? ', and turn on JSON output (`response_format: {type: "json_object"}` or `responseMimeType: "application/json"`)' : ""}:`, "", "```text", r.patch.systemAddition, "```");
  }
  return lines.join("\n");
}

// packages/replay/dist/job.js
async function runReplayJob(job) {
  const { items, oldModel, newModel, runs, maxCalls, concurrency, client } = job;
  const records = await runReplay({
    items,
    oldModel,
    newModel,
    runs,
    concurrency,
    maxCalls,
    client,
    ...job.signal ? { signal: job.signal } : {},
    ...job.onProgress ? { onProgress: job.onProgress } : {}
  });
  const report = buildReplayReport(items, records, { oldModel, newModel, runs });
  if (!job.repair || !report.items.some(repairable))
    return { report, records };
  const left = maxCalls - records.length;
  const needed = plannedRepairCalls(items, report.items, newModel, runs);
  if (needed > left) {
    return { report, records, repairSkipped: `Prompt Repair skipped: it could need ${needed} calls, and only ${left} are left under the limit of ${maxCalls}.` };
  }
  try {
    const repair = await runRepair({ items, records, results: report.items, newModel, client, runs, concurrency, maxCalls: left, ...job.signal ? { signal: job.signal } : {} });
    return { report, records, repair };
  } catch (error) {
    return { report, records, repairSkipped: `Prompt Repair failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// packages/scanner/dist/detect.js
var NOT_MODELS = /* @__PURE__ */ new Set(["claude-code", "claude-desktop", "gemini-cli", "gemini-code-assist"]);
var GATEWAY_PLATFORMS = {
  openai: void 0,
  anthropic: void 0,
  google: void 0,
  gemini: void 0,
  mistral: void 0,
  mistralai: void 0,
  openrouter: void 0,
  litellm: void 0,
  together_ai: void 0,
  groq: void 0,
  vertex_ai: "vertex-ai",
  vertex: "vertex-ai",
  bedrock: "aws-bedrock",
  azure: "azure-openai"
};
var OPENAI_RE = /^(?:gpt-\d[a-z0-9.\-]*|chatgpt-4o-latest|text-davinci-\d{3}|text-embedding-(?:3-small|3-large|ada-002))$/;
var OPENAI_O_SERIES_RE = /^o\d(?:-(?:mini|pro|preview|deep-research))*(?:-\d{4}-\d{2}-\d{2})?$/;
var CLAUDE_RE = /^claude-[a-z0-9.\-]+$/;
var BEDROCK_CLAUDE_RE = /^(?:(?:us|eu|apac|global)\.)?anthropic\.(claude-[a-z0-9.\-]+?)(?:-v\d+(?::\d+)?)?$/;
var GEMINI_RE = /^(?:models\/)?(gemini-[a-z0-9.\-]+)$/;
var MISTRAL_RE = /^(?:mistral|codestral|pixtral|ministral|magistral|devstral|open-mistral|open-mixtral)-[a-z0-9.\-]+$/;
function classifyModelId(literal) {
  let s = literal.trim().toLowerCase();
  if (s.length < 2 || s.length > 120)
    return null;
  let fineTuned = false;
  if (s.startsWith("ft:")) {
    s = s.slice(3).split(":")[0] ?? "";
    fineTuned = true;
  }
  let gateway;
  let platformHint;
  if (s.includes("/") && !s.startsWith("models/")) {
    const parts = s.split("/");
    const prefix = parts[0] ?? "";
    if (!(prefix in GATEWAY_PLATFORMS) || parts.length > 3)
      return null;
    gateway = prefix;
    platformHint = GATEWAY_PLATFORMS[prefix];
    s = parts[parts.length - 1] ?? "";
  }
  if (!s || NOT_MODELS.has(s))
    return null;
  const base = { raw: literal };
  if (fineTuned)
    base.fineTuned = true;
  if (gateway)
    base.gateway = gateway;
  if (platformHint)
    base.platformHint = platformHint;
  const bedrock = BEDROCK_CLAUDE_RE.exec(s);
  if (bedrock?.[1])
    return { ...base, provider: "anthropic", id: bedrock[1], platformHint: "aws-bedrock" };
  if (CLAUDE_RE.test(s) && /\d/.test(s))
    return { ...base, provider: "anthropic", id: s };
  const gemini = GEMINI_RE.exec(s);
  if (gemini?.[1] && /\d/.test(gemini[1]))
    return { ...base, provider: "google", id: gemini[1] };
  if (OPENAI_RE.test(s))
    return { ...base, provider: "openai", id: s };
  if (OPENAI_O_SERIES_RE.test(s))
    return { ...base, provider: "openai", id: s, weak: true };
  if (MISTRAL_RE.test(s) && /\d|latest/.test(s))
    return { ...base, provider: "mistral", id: s };
  return null;
}
var STRING_RE = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
var CONFIG_VALUE_RE = /^\s*(?:export\s+)?[\w.\-]+\s*[=:]\s*["']?([^"'#\s,]+)/;
var YAML_ITEM_RE = /^\s*-\s+["']?([^"'#\s,]+)/;
function valueSpans(line, kind) {
  const spans = [];
  for (const m of line.matchAll(STRING_RE)) {
    if (m[2])
      spans.push({ start: m.index + 1, end: m.index + 1 + m[2].length });
  }
  if (kind === "config") {
    const m = new RegExp(CONFIG_VALUE_RE.source, "d").exec(line) ?? new RegExp(YAML_ITEM_RE.source, "d").exec(line);
    const at = m?.indices?.[1];
    if (at)
      spans.push({ start: at[0], end: at[1] });
  }
  return spans;
}
function candidates2(line, kind) {
  const out = [];
  for (const m of line.matchAll(STRING_RE)) {
    if (m[2])
      out.push(m[2]);
  }
  if (kind === "config") {
    const value = CONFIG_VALUE_RE.exec(line)?.[1] ?? YAML_ITEM_RE.exec(line)?.[1];
    if (value)
      out.push(value);
  }
  return out;
}
var AI_MARKERS = [
  "openai",
  "anthropic",
  "google.genai",
  "google.generativeai",
  "from google import genai",
  "from google import generativeai",
  "@google/genai",
  "@google/generative-ai",
  "vertexai",
  "langchain",
  "litellm",
  "mistralai",
  "@ai-sdk/",
  "bedrock-runtime",
  "ollama"
];
var SDK_CALL_PATTERNS = [
  /\bchat\.completions\.create\b/,
  /\bresponses\.create\b/,
  /\bmessages\.(?:create|stream)\b/,
  /\bgenerate_?[cC]ontent(?:_?[sS]tream)?\b/,
  /\bembeddings\.create\b/,
  /\bChat(?:OpenAI|Anthropic|GoogleGenerativeAI|VertexAI|Mistral(?:AI)?)\s*\(/,
  /\blitellm\.a?completion\s*\(/,
  /\b(?:generateText|streamText|generateObject|streamObject)\s*\(/,
  /\bInvokeModel(?:Command|WithResponseStreamCommand)?\b|\binvoke_model\b/
];
var DYNAMIC_MODEL_RE = /\bmodel(?:_?[nN]ame|_?[iI]d)?\s*[:=]\s*(?![\s"'`=])([A-Za-z_$][\w$]*(?:\.[\w$]+)*(?:\[[^\]]*\])?)/;
var COMMENT_LINE_RE = /^\s*(?:#|\/\/|\/\*|\*|--)/;
var TYPE_WORDS = /* @__PURE__ */ new Set([
  "string",
  "str",
  "number",
  "int",
  "float",
  "any",
  "unknown",
  "boolean",
  "bool",
  "Optional",
  "Literal",
  "None",
  "null",
  "undefined",
  "true",
  "false",
  "String",
  "Model"
]);
function isAiContent(content) {
  const lower = content.toLowerCase();
  return AI_MARKERS.some((m) => lower.includes(m));
}
function compileApiRules(apis2) {
  return apis2.map((a) => ({ id: a.id, regexes: a.patterns.map((p) => new RegExp(p)) }));
}
function scanText(file, content, kind, apiRules) {
  const isAiFile = isAiContent(content);
  const findings = [];
  let callSites = 0;
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const snippet = line.trim().slice(0, 160);
    const seen = /* @__PURE__ */ new Set();
    for (const candidate of candidates2(line, kind)) {
      const hit = classifyModelId(candidate);
      if (!hit || seen.has(hit.id))
        continue;
      if (hit.weak && !isAiFile)
        continue;
      seen.add(hit.id);
      findings.push({ file, line: lineNo, kind: "model", snippet, model: hit });
    }
    if (kind === "code" && isAiFile && seen.size === 0 && !COMMENT_LINE_RE.test(line)) {
      const dynamic = DYNAMIC_MODEL_RE.exec(line);
      const value = dynamic?.[1];
      if (value && !TYPE_WORDS.has(value)) {
        findings.push({ file, line: lineNo, kind: "dynamic-model", snippet });
      }
    }
    if (kind === "code" && SDK_CALL_PATTERNS.some((re) => re.test(line)))
      callSites++;
    for (const rule of apiRules) {
      if (rule.regexes.some((re) => re.test(line))) {
        findings.push({ file, line: lineNo, kind: "deprecated-api", snippet, apiId: rule.id });
      }
    }
  });
  return { findings, isAiFile, callSites };
}

// packages/scanner/dist/scan.js
import { readFile as readFile2, stat } from "node:fs/promises";

// packages/catalog/dist/index.js
import { readFileSync } from "node:fs";
function load(file) {
  return JSON.parse(readFileSync(new URL(`../data/${file}`, import.meta.url), "utf8"));
}
var models = load("models.json").models;
var apis = load("apis.json").apis;
var defaultPlatform = {
  openai: "openai-api",
  anthropic: "anthropic-api",
  google: "gemini-api",
  mistral: "mistral-api"
};
function lookupModel(id) {
  return models.filter((m) => m.id === id);
}

// packages/scanner/dist/tokens.js
var TOKEN_RULES = {
  "no-output-limit": {
    title: "No output limit on the AI call",
    fix: "Set max_tokens / max_output_tokens to the longest answer you actually need.",
    saving: "Caps runaway answers; output tokens usually cost several times more than input tokens."
  },
  "no-prompt-caching": {
    title: "System prompt sent without prompt caching (Anthropic)",
    fix: 'Add cache_control: {"type": "ephemeral"} to the fixed system prompt block.',
    saving: "Cached input is billed at a fraction of the normal input price on repeat calls (check current Anthropic pricing)."
  },
  "cache-breaker": {
    title: "Changing value inside the system prompt",
    fix: "Move dates, times and IDs out of the system prompt and into the end of the user message.",
    saving: "Keeps the prompt prefix identical so provider prompt caching can apply."
  },
  "loop-not-batched": {
    title: "AI calls made one by one in a loop",
    fix: "If results aren't needed instantly, send the loop through the provider's Batch API.",
    saving: "Batch APIs are often around half price (confirm each provider's current discount)."
  },
  "json-without-structured-output": {
    title: "JSON parsed from free-text AI output",
    fix: "Ask for structured output (response_format / JSON schema / responseMimeType) instead of parsing text.",
    saving: "Shorter answers and fewer retries when the JSON comes back broken."
  }
};
var CALL_RE = /\b(?:chat\.completions\.create|responses\.create|messages\.(?:create|stream)|generate_?[cC]ontent|generateText|streamText)\s*\(/;
var ANTHROPIC_CALL_RE = /\bmessages\.(?:create|stream)\s*\(/;
var OUTPUT_LIMIT_RE = /\b(?:max_tokens|max_completion_tokens|max_output_tokens|maxTokens|maxOutputTokens|maxCompletionTokens)\b/;
var SPREAD_RE = /\*\*\w|\.\.\.\w/;
var SYSTEM_PARAM_RE = /\bsystem\s*[=:]/;
var PROMPT_VAR_RE = /\b(?:system(?:_prompt|Prompt)?|instructions)\b\s*[=:]/;
var CHANGING_VALUE_RE = /\b(?:datetime\.(?:now|utcnow)|date\.today|time\.time|Date\.now)\s*\(|\bnew Date\s*\(|\buuid\d?\s*\(/;
var LOOP_RE = /^\s*(?:for\s|async for\s|while\s|for\s*\()|\.(?:map|forEach)\s*\(/;
var FUNCTION_START_RE = /^\s*(?:def |async def |function |class |export )/;
var JSON_PARSE_RE = /\b(?:json\.loads|JSON\.parse)\s*\(/;
var AI_OUTPUT_RE = /\bchoices\s*\[|\boutput_text\b|\bmessage\.content\b|\.content\s*\[\s*\d+\s*\]\s*\.text\b|\bresponse\.text\b|\bcompletion\.text\b/;
var EMPTY_ARGS_RE = /^\(\s*\)/;
var TRIPLE_QUOTE_RE = /"""|'''/g;
var STRUCTURED_RE = /\b(?:response_format|json_schema|responseMimeType|response_mime_type|responseSchema|response_schema|generateObject|zodResponseFormat|text_format|output_format|tool_choice)\b/;
var COMMENT_LINE_RE2 = /^\s*(?:#|\/\/|\/\*|\*|--)/;
function callBlock(lines, start, column) {
  let depth = 0;
  const parts = [];
  for (let i = start; i < lines.length && i < start + 40; i++) {
    const text = i === start ? (lines[i] ?? "").slice(column) : lines[i] ?? "";
    parts.push(text);
    for (const ch of text) {
      if (ch === "(")
        depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0)
          return parts.join("\n");
      }
    }
  }
  return parts.join("\n");
}
function indentOf(line) {
  return line.length - line.trimStart().length;
}
function insideLoop(lines, index, column) {
  const line = lines[index] ?? "";
  if (LOOP_RE.test(line.slice(0, column)))
    return true;
  const indent = indentOf(line);
  for (let j = index - 1; j >= 0 && j >= index - 8; j--) {
    const prev = lines[j] ?? "";
    if (prev.trim() === "")
      continue;
    if (indentOf(prev) >= indent)
      continue;
    if (LOOP_RE.test(prev))
      return true;
    if (FUNCTION_START_RE.test(prev))
      return false;
  }
  return false;
}
function findTokenTips(file, content, kind) {
  if (kind !== "code")
    return [];
  const lines = content.split(/\r?\n/);
  const tips = [];
  const usesBatch = /batch/i.test(content);
  const usesCacheControl = /cache_control|cacheControl/.test(content);
  const usesStructuredOutput = STRUCTURED_RE.test(content);
  let cacheTipGiven = false;
  let jsonTipGiven = false;
  let inDocstring = false;
  lines.forEach((line, index) => {
    const quoteCount = (line.match(TRIPLE_QUOTE_RE) ?? []).length;
    const wasInDocstring = inDocstring;
    if (quoteCount % 2 === 1)
      inDocstring = !inDocstring;
    if (wasInDocstring || quoteCount > 0 || COMMENT_LINE_RE2.test(line))
      return;
    const tip = (rule) => tips.push({ file, line: index + 1, rule, snippet: line.trim().slice(0, 160) });
    const call = CALL_RE.exec(line);
    if (call && !EMPTY_ARGS_RE.test(line.slice(call.index + call[0].length - 1))) {
      const column = call.index + call[0].length - 1;
      const block = callBlock(lines, index, column);
      if (!OUTPUT_LIMIT_RE.test(block) && !SPREAD_RE.test(block))
        tip("no-output-limit");
      if (!usesCacheControl && !cacheTipGiven && ANTHROPIC_CALL_RE.test(line) && SYSTEM_PARAM_RE.test(block)) {
        tip("no-prompt-caching");
        cacheTipGiven = true;
      }
      if (!usesBatch && insideLoop(lines, index, call.index))
        tip("loop-not-batched");
    }
    if (PROMPT_VAR_RE.test(line) && CHANGING_VALUE_RE.test(line))
      tip("cache-breaker");
    if (!usesStructuredOutput && !jsonTipGiven && JSON_PARSE_RE.test(line) && AI_OUTPUT_RE.test(line)) {
      tip("json-without-structured-output");
      jsonTipGiven = true;
    }
  });
  return tips;
}

// packages/scanner/dist/walk.js
import { readdir } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
var SKIP_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "out",
  "coverage",
  "vendor",
  "venv",
  ".venv",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "target",
  ".turbo",
  ".cache"
]);
var SKIP_FILES = /* @__PURE__ */ new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock"
]);
var CODE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".java",
  ".kt",
  ".go",
  ".rb",
  ".php",
  ".cs",
  ".rs",
  ".swift",
  ".dart"
]);
var CONFIG_EXTENSIONS = /* @__PURE__ */ new Set([".yaml", ".yml", ".json", ".toml", ".ini", ".properties", ".cfg"]);
function fileKind(name) {
  const base = basename(name);
  if (base === ".env" || base.startsWith(".env."))
    return "config";
  if (/^requirements[\w.-]*\.txt$/i.test(base))
    return "config";
  if (base.endsWith(".min.js"))
    return null;
  const ext = extname(base).toLowerCase();
  if (CODE_EXTENSIONS.has(ext))
    return "code";
  if (CONFIG_EXTENSIONS.has(ext))
    return "config";
  return null;
}
async function* walk(root) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink())
        continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name))
          stack.push(full);
        continue;
      }
      if (!entry.isFile() || SKIP_FILES.has(entry.name))
        continue;
      const kind = fileKind(entry.name);
      if (kind)
        yield { path: full, rel: relative(root, full).split(sep).join("/"), kind };
    }
  }
}

// packages/scanner/dist/scan.js
var MAX_FILE_BYTES = 1e6;
async function scanDirectory(root) {
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory())
    throw new Error(`Not a folder: ${root}`);
  const rules = compileApiRules(apis);
  const result = { root, filesScanned: 0, aiFiles: 0, callSites: 0, findings: [], tokenTips: [] };
  for await (const file of walk(root)) {
    const size = (await stat(file.path)).size;
    if (size > MAX_FILE_BYTES)
      continue;
    const content = await readFile2(file.path, "utf8");
    if (content.includes("\0"))
      continue;
    const scanned = scanText(file.rel, content, file.kind, rules);
    result.filesScanned++;
    if (scanned.isAiFile && file.kind === "code")
      result.aiFiles++;
    result.callSites += scanned.callSites;
    result.findings.push(...scanned.findings);
    if (scanned.isAiFile)
      result.tokenTips.push(...findTokenTips(file.rel, content, file.kind));
  }
  return result;
}

// packages/scanner/dist/report.js
var STATUS_ORDER = {
  retired: 0,
  rerouted: 1,
  retiring: 2,
  rerouting: 3,
  "no-known-retirement": 4
};
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);
}
function statusFor(entry, today) {
  if (!entry)
    return { status: "no-known-retirement" };
  const daysLeft = daysBetween(today, entry.retiresOn);
  const past = daysLeft <= 0;
  const status = entry.reroutesTo ? past ? "rerouted" : "rerouting" : past ? "retired" : "retiring";
  return { status, daysLeft, date: entry.retiresOn };
}
function buildReport(result, target, today) {
  const rows = /* @__PURE__ */ new Map();
  const dynamic = [];
  const apiLocations = /* @__PURE__ */ new Map();
  for (const f of result.findings) {
    const location = `${f.file}:${f.line}`;
    if (f.kind === "dynamic-model") {
      dynamic.push({ location, snippet: f.snippet });
    } else if (f.kind === "deprecated-api" && f.apiId) {
      const list = apiLocations.get(f.apiId) ?? [];
      list.push(location);
      apiLocations.set(f.apiId, list);
    } else if (f.kind === "model" && f.model) {
      const hit = f.model;
      const platform = hit.platformHint ?? defaultPlatform[hit.provider];
      const key = `${hit.id}|${platform}`;
      let row = rows.get(key);
      if (!row) {
        const entries = lookupModel(hit.id);
        const primary = entries.find((e) => e.platform === platform);
        row = {
          id: hit.id,
          provider: hit.provider,
          platform,
          ...statusFor(primary, today),
          fineTuned: false,
          gateways: [],
          otherPlatforms: entries.filter((e) => e !== primary).map((e) => ({ platform: e.platform, date: e.retiresOn })),
          locations: []
        };
        if (primary) {
          row.verified = primary.verified;
          if (primary.reroutesTo)
            row.reroutesTo = primary.reroutesTo;
          if (primary.replacement)
            row.replacement = primary.replacement;
          if (primary.note)
            row.note = primary.note;
        }
        rows.set(key, row);
      }
      if (hit.fineTuned)
        row.fineTuned = true;
      if (hit.gateway && !row.gateways.includes(hit.gateway))
        row.gateways.push(hit.gateway);
      row.locations.push(location);
    }
  }
  const models2 = [...rows.values()].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) || a.id.localeCompare(b.id));
  const apiRows = [];
  for (const [id, locations] of apiLocations) {
    const entry = apis.find((a) => a.id === id);
    if (!entry)
      continue;
    const row = {
      id,
      name: entry.name,
      date: entry.retiresOn,
      daysLeft: daysBetween(today, entry.retiresOn),
      verified: entry.verified,
      locations
    };
    if (entry.replacement)
      row.replacement = entry.replacement;
    apiRows.push(row);
  }
  apiRows.sort((a, b) => a.daysLeft - b.daysLeft);
  const tipRows = /* @__PURE__ */ new Map();
  for (const tip of result.tokenTips) {
    let row = tipRows.get(tip.rule);
    if (!row) {
      row = { rule: tip.rule, ...TOKEN_RULES[tip.rule], locations: [] };
      tipRows.set(tip.rule, row);
    }
    row.locations.push(`${tip.file}:${tip.line}`);
  }
  const tokenTips = [...tipRows.values()].sort((a, b) => b.locations.length - a.locations.length);
  return {
    target,
    today,
    filesScanned: result.filesScanned,
    aiFiles: result.aiFiles,
    callSites: result.callSites,
    models: models2,
    dynamic,
    apis: apiRows,
    tokenTips
  };
}

// packages/scanner/dist/check.js
var SOON_DAYS = 90;
function inChangedFiles(locations, changed) {
  return locations.some((loc) => changed.has(loc.replace(/:\d+$/, "")));
}
function statusText(row) {
  if (row.status === "retired")
    return `Retired ${row.date}`;
  if (row.status === "rerouted")
    return `Rerouted to ${row.reroutesTo} since ${row.date}`;
  if (row.status === "retiring")
    return `Retires ${row.date} (${row.daysLeft} days)`;
  if (row.status === "rerouting")
    return `Reroutes to ${row.reroutesTo} on ${row.date} (${row.daysLeft} days)`;
  return "No retirement known";
}
function buildCheck(report, changedFiles) {
  const changed = new Set(changedFiles ?? []);
  const dead = report.models.filter((m) => m.status === "retired" || m.status === "rerouted");
  const soon = report.models.filter((m) => (m.status === "retiring" || m.status === "rerouting") && (m.daysLeft ?? Infinity) <= SOON_DAYS);
  const deadApis = report.apis.filter((a) => a.daysLeft <= 0);
  const soonApis = report.apis.filter((a) => a.daysLeft > 0 && a.daysLeft <= SOON_DAYS);
  const introducedDead = dead.some((m) => inChangedFiles(m.locations, changed)) || deadApis.some((a) => inChangedFiles(a.locations, changed));
  const conclusion = introducedDead ? "failure" : dead.length + deadApis.length + soon.length + soonApis.length > 0 ? "neutral" : "success";
  const parts = [];
  if (dead.length + deadApis.length > 0)
    parts.push(`${dead.length + deadApis.length} retired`);
  if (soon.length + soonApis.length > 0)
    parts.push(`${soon.length + soonApis.length} changing within ${SOON_DAYS} days`);
  const title = parts.length > 0 ? `AI models and APIs: ${parts.join(", ")}` : `${report.models.length} AI models found, none changing soon`;
  const lines = [];
  if (introducedDead)
    lines.push("**This pull request touches code that uses a retired AI model or API.**", "");
  const rows = [...dead, ...soon];
  if (rows.length > 0) {
    const prColumn = changedFiles !== null;
    lines.push(prColumn ? "| Model | Status | Where | In this PR |" : "| Model | Status | Where |", prColumn ? "| --- | --- | --- | --- |" : "| --- | --- | --- |");
    for (const m of rows) {
      const where = m.locations.slice(0, 3).map((l) => `\`${l}\``).join(", ") + (m.locations.length > 3 ? ` +${m.locations.length - 3} more` : "");
      const prCell = prColumn ? ` ${inChangedFiles(m.locations, changed) ? "yes" : ""} |` : "";
      lines.push(`| \`${m.id}\` | ${statusText(m)} | ${where} |${prCell}`);
    }
    lines.push("");
  }
  for (const a of [...deadApis, ...soonApis]) {
    lines.push(`- **${a.name}** ${a.daysLeft <= 0 ? "shut down" : "shuts down"} ${a.date}${a.replacement ? ` (replacement: ${a.replacement})` : ""}`);
  }
  if (report.tokenTips.length > 0) {
    lines.push("", "**Token Saver:** " + report.tokenTips.map((t) => `${t.title} (${t.locations.length})`).join(" \xB7 "));
  }
  lines.push("", `Scanned ${report.filesScanned} files \xB7 ${report.models.length} models \xB7 ${report.callSites} AI call sites.`);
  return { conclusion, title, summary: lines.join("\n") };
}

// packages/scanner/dist/switch.js
import { readFile as readFile3, writeFile } from "node:fs/promises";
import { join as join2 } from "node:path";
var MODEL_ID_RE = /^[A-Za-z0-9][\w.\-:@]{0,119}$/;
var ID_CHAR_BEFORE = /[\w.\-@]/;
var ID_CHAR_AFTER = /[\w.\-/:@]/;
var TOKEN_CHAR = /[\w.\-/:@]/;
var REASONS = {
  fineTuned: "Fine-tuned model: train a new fine-tune on the new model first.",
  bedrock: "Bedrock model IDs have their own format; change this one by hand.",
  azure: "Azure calls a deployment name; deploy the new model on Azure, then change this by hand.",
  other: "Written in a form AI Change Guard does not rewrite automatically."
};
function checkSwitchIds(from, to) {
  const fromId = from.trim().toLowerCase();
  const toId = to.trim();
  if (!MODEL_ID_RE.test(fromId) || !MODEL_ID_RE.test(toId))
    throw new Error("Model IDs may only contain letters, digits and . - _ : @");
  if (fromId === toId.toLowerCase())
    throw new Error("The old and new model are the same.");
  return { from: fromId, to: toId };
}
function findingReason(finding, from) {
  const hit = finding.model;
  if (hit.fineTuned)
    return REASONS.fineTuned;
  if (hit.platformHint === "aws-bedrock")
    return REASONS.bedrock;
  if (hit.platformHint === "azure-openai")
    return REASONS.azure;
  const raw = hit.raw.trim().toLowerCase();
  return raw === from || raw.endsWith(`/${from}`) ? null : REASONS.other;
}
function rewriteLine(line, kind, from, to, opts) {
  const spans = valueSpans(line, kind);
  const lower = line.toLowerCase();
  const reasons = [];
  let out = "";
  let last = 0;
  for (let i = lower.indexOf(from); i !== -1; i = lower.indexOf(from, i + 1)) {
    const end = i + from.length;
    if (end > line.length || i > 0 && ID_CHAR_BEFORE.test(line[i - 1]) || end < line.length && ID_CHAR_AFTER.test(line[end]))
      continue;
    if (!spans.some((s) => i >= s.start && end <= s.end))
      continue;
    let start = i;
    while (start > 0 && TOKEN_CHAR.test(line[start - 1]))
      start--;
    const prefix = lower.slice(start, i);
    if (prefix.startsWith("ft:") || prefix.endsWith("ft:"))
      reasons.push(REASONS.fineTuned);
    else if (/(^|\/)azure\/$/.test(prefix))
      reasons.push(REASONS.azure);
    else if (/(^|\/)bedrock\/$/.test(prefix))
      reasons.push(REASONS.bedrock);
    else if (opts.prefix && !prefix.endsWith(`${opts.prefix.toLowerCase()}/`)) {
      reasons.push(`Not called through ${opts.prefix}/, the route the replay tested.`);
    } else {
      out += line.slice(last, i) + to;
      last = end;
    }
  }
  return { line: out + line.slice(last), reasons };
}
async function planSwitch(root, findings, from, to, opts = {}) {
  const ids = checkSwitchIds(from, to);
  const plan = { ...ids, edits: [], skipped: [], files: /* @__PURE__ */ new Map() };
  const byFile = /* @__PURE__ */ new Map();
  for (const f of findings) {
    if (f.kind !== "model" || f.model?.id !== ids.from)
      continue;
    const lines = byFile.get(f.file) ?? /* @__PURE__ */ new Map();
    lines.set(f.line, [...lines.get(f.line) ?? [], f]);
    byFile.set(f.file, lines);
  }
  for (const [file, uses] of byFile) {
    const kind = fileKind(file);
    if (!kind)
      continue;
    const lines = (await readFile3(join2(root, file), "utf8")).split("\n");
    let changed = false;
    for (const [lineNo, lineFindings] of uses) {
      const original = lines[lineNo - 1];
      if (original === void 0)
        continue;
      const result = rewriteLine(original, kind, ids.from, ids.to, opts);
      const reasons = new Set(result.reasons);
      for (const f of lineFindings) {
        const reason = findingReason(f, ids.from);
        if (reason && reason !== REASONS.other)
          reasons.add(reason);
      }
      if (result.line !== original) {
        lines[lineNo - 1] = result.line;
        changed = true;
        plan.edits.push({ file, line: lineNo, before: original.trim(), after: result.line.trim() });
      } else if (reasons.size === 0) {
        reasons.add(lineFindings.some((f) => findingReason(f, ids.from)) ? REASONS.other : "Could not place the change on this line.");
      }
      const raw = lineFindings[0].model.raw;
      for (const reason of reasons)
        plan.skipped.push({ file, line: lineNo, raw, reason });
    }
    if (changed)
      plan.files.set(file, lines.join("\n"));
  }
  plan.edits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  plan.skipped.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return plan;
}

// action/src/pr.ts
import { createHash } from "node:crypto";
import { readFile as readFile4 } from "node:fs/promises";
import { join as join3, posix } from "node:path";
var GitHubError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
};
function githubApi(token, baseUrl = "https://api.github.com", fetchImpl = fetch) {
  return async (method, path, body) => {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ai-change-guard-action",
        ...body === void 0 ? {} : { "Content-Type": "application/json" }
      },
      body: body === void 0 ? void 0 : JSON.stringify(body)
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))).message ?? "";
      throw new GitHubError(res.status, `GitHub ${res.status} on ${method} ${path.split("?")[0]}${detail ? `: ${detail}` : ""}`);
    }
    return res.status === 204 ? void 0 : await res.json();
  };
}
var MAX_BODY = 6e4;
var MAX_LISTED = 50;
function branchName(from, to) {
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9.\-]+/g, "-").replace(/^-+|-+$/g, "");
  return `ai-change-guard/${slug(from)}-to-${slug(to)}`;
}
function code2(text) {
  return "`" + text.replace(/\s+/g, " ").slice(0, 200).replace(/`/g, "'") + "`";
}
function listed(items, render, more) {
  return [...items.slice(0, MAX_LISTED).map(render), ...items.length > MAX_LISTED ? [`- \u2026and ${items.length - MAX_LISTED} more ${more}`] : []];
}
function evidenceBody(plan, replay, scanPath, note) {
  const where = (file, line) => `\`${posix.join(scanPath || ".", file)}:${line}\``;
  const t = replay.totals;
  const prompts = replay.items.length;
  const lines = [
    ...note ? [`> ${note}`, ""] : [],
    `## Switch \`${plan.from}\` to \`${plan.to}\``,
    "",
    `Before opening this pull request, AI Change Guard replayed **${prompts} of your real prompt${prompts === 1 ? "" : "s"}** ${replay.runs} time${replay.runs === 1 ? "" : "s"} each on \`${replay.oldModel}\` and \`${replay.newModel}\`.`,
    "",
    "| Same | Changed | Broken | Errors |",
    "| ---: | ---: | ---: | ---: |",
    `| ${t.same} | ${t.changed} | ${t.broken} | ${t.error} |`,
    "",
    t.changed > 0 ? `**${t.changed} prompt${t.changed === 1 ? "" : "s"} answered differently but passed your checks.** Read them in the full report below before merging.` : "Every prompt passed your checks with the same kind of answer on both models.",
    "",
    `### Code changes (${plan.edits.length})`,
    "",
    ...listed(plan.edits, (e) => `- ${where(e.file, e.line)}: ${code2(e.before)} \u2192 ${code2(e.after)}`, "(see the Files tab)")
  ];
  if (plan.skipped.length > 0) {
    lines.push("", `### Not changed automatically (${plan.skipped.length})`, "");
    lines.push(...listed(plan.skipped, (s) => `- ${where(s.file, s.line)}: ${code2(s.raw)}. ${s.reason}`, "(run `ai-change-guard switch` locally to see all)"));
  }
  lines.push(
    "",
    "### Before you merge",
    "",
    `- Settings are not checked yet: make sure every option you pass (temperature, max_tokens, tools, \u2026) is supported by \`${plan.to}\`.`,
    "- Model IDs built at runtime (from variables or environment) are not changed; search for them by hand.",
    "- A pull request opened with the default workflow token does not start other workflows. Close and reopen it, or give the Action a `github-token` from a GitHub App or a personal token, to run your CI on it.",
    ""
  );
  const top = lines.join("\n");
  const open = "\n<details><summary>Full replay report</summary>\n\n";
  const close = "\n\n</details>";
  const cut = "\n\n\u2026cut to fit GitHub's limit; the full report is in the workflow run's Summary.";
  let report = formatReplayMarkdown(replay);
  const room = MAX_BODY - top.length - open.length - close.length;
  if (report.length > room) report = report.slice(0, Math.max(0, room - cut.length)) + cut;
  return top + open + report + close;
}
var PERMISSION_HELP = 'Give the job `permissions: { contents: write, pull-requests: write }`, and in Settings \u2192 Actions \u2192 General turn on "Allow GitHub Actions to create and approve pull requests".';
function permissionHint(error) {
  if (error instanceof GitHubError && (error.status === 403 || error.status === 404)) return new Error(`${error.message.replace(/\.+$/, "")}. ${PERMISSION_HELP}`);
  return error;
}
function gitBlobSha(content) {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}
async function trackedOnly(input2) {
  const { api, repo, plan } = input2;
  const tree = await api(
    "GET",
    `/repos/${repo}/git/trees/${input2.sha}?recursive=1`
  );
  if (tree.truncated) throw new Error("The repository has too many files for GitHub to list in one tree, so AI Change Guard cannot check which files it may commit.");
  const tracked = new Map(tree.tree.filter((e) => e.type === "blob").map((e) => [e.path, e]));
  const keep = { ...plan, edits: [], skipped: [...plan.skipped], files: /* @__PURE__ */ new Map() };
  const modes = /* @__PURE__ */ new Map();
  for (const [file, content] of plan.files) {
    const path = posix.join(input2.scanPath || ".", file);
    const entry = tracked.get(path);
    const reason = !entry ? "Not committed in the repository (untracked or gitignored), so it is left out of the PR." : gitBlobSha(await readFile4(join3(input2.workspace, path))) !== entry.sha ? "Changed by an earlier step of this job, so it is left out of the PR." : null;
    const edits = plan.edits.filter((e) => e.file === file);
    if (reason) {
      keep.skipped.push(...edits.map((e) => ({ file, line: e.line, raw: plan.from, reason })));
      continue;
    }
    keep.edits.push(...edits);
    keep.files.set(file, content);
    modes.set(path, entry.mode);
  }
  keep.skipped.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { plan: keep, modes };
}
async function openEvidencePr(input2) {
  const { api, repo, replay } = input2;
  const { default_branch: base } = await api("GET", `/repos/${repo}`);
  if (input2.ref !== `refs/heads/${base}`) {
    return { action: "skipped", reason: `Evidence PRs are opened from runs on ${base} (push, schedule or workflow_dispatch), not from ${input2.ref}.` };
  }
  const head = await api("GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
  if (head.object.sha !== input2.sha) {
    return { action: "skipped", reason: `${base} moved on while this run was going; the next run opens the PR.` };
  }
  const { plan, modes } = await trackedOnly(input2);
  if (plan.files.size === 0) return { action: "skipped", reason: "None of the files to change are committed and unchanged in the repository." };
  const branch = branchName(plan.from, plan.to);
  const owner = repo.split("/")[0];
  const t = replay.totals;
  const subject = `Switch ${plan.from} to ${plan.to}`;
  const message = `${subject}

Replayed ${replay.items.length} prompt${replay.items.length === 1 ? "" : "s"} x ${replay.runs} run${replay.runs === 1 ? "" : "s"} with AI Change Guard: ${t.same} same, ${t.changed} changed, ${t.broken} broken.`;
  const body = evidenceBody(plan, replay, input2.scanPath);
  const listPulls = () => api("GET", `/repos/${repo}/pulls?state=all&per_page=20&head=${encodeURIComponent(`${owner}:${branch}`)}`);
  const ownsBranch = async () => {
    const cmp = await api(
      "GET",
      `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`
    );
    const ours = cmp.ahead_by === 0 || cmp.ahead_by === 1 && cmp.commits[0]?.commit.message.startsWith(`${subject}
`) === true;
    return { owned: ours, behind: cmp.behind_by };
  };
  const commit = async () => {
    const tree = [...plan.files].map(([file, content]) => {
      const path = posix.join(input2.scanPath || ".", file);
      return { path, mode: modes.get(path), type: "blob", content };
    });
    const parent = await api("GET", `/repos/${repo}/git/commits/${input2.sha}`);
    const newTree = await api("POST", `/repos/${repo}/git/trees`, { base_tree: parent.tree.sha, tree });
    return (await api("POST", `/repos/${repo}/git/commits`, { message, tree: newTree.sha, parents: [input2.sha] })).sha;
  };
  const refresh = async (pr) => {
    const { owned, behind } = await ownsBranch();
    if (owned && behind > 0) {
      await api("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha: await commit(), force: true });
    }
    const note = owned ? void 0 : `People have added commits to this branch, so AI Change Guard no longer changes its code. The lists below describe ${base} today.`;
    await api("PATCH", `/repos/${repo}/pulls/${pr.number}`, { body: owned ? body : evidenceBody(plan, replay, input2.scanPath, note) });
    return { action: "updated", number: pr.number, url: pr.html_url };
  };
  try {
    const existing = await listPulls();
    const open = existing.find((p) => p.state === "open");
    if (open) return await refresh(open);
    const closed = existing.find((p) => p.state === "closed" && !p.merged_at);
    if (closed) {
      return { action: "skipped", reason: `Pull request #${closed.number} for this switch was closed without merging, so no new one is opened. Reopen it to continue.` };
    }
    const sha = await commit();
    try {
      await api("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 422) throw error;
      if (!(await ownsBranch()).owned) {
        return { action: "skipped", reason: `Branch ${branch} already exists with other commits; delete it to get a new pull request.` };
      }
      await api("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha, force: true });
    }
    try {
      const pr = await api("POST", `/repos/${repo}/pulls`, {
        title: `${subject} (tested on ${replay.items.length} real prompt${replay.items.length === 1 ? "" : "s"})`,
        head: branch,
        base,
        body
      });
      return { action: "created", number: pr.number, url: pr.html_url };
    } catch (error) {
      const raced = error instanceof GitHubError && error.status === 422 ? (await listPulls()).find((p) => p.state === "open") : void 0;
      if (!raced) throw error;
      await api("PATCH", `/repos/${repo}/pulls/${raced.number}`, { body });
      return { action: "updated", number: raced.number, url: raced.html_url };
    }
  } catch (error) {
    throw permissionHint(error);
  }
}

// action/src/main.ts
var SOON_DAYS2 = 90;
function input(name, env) {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}
function positive(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Input "${name}" must be a whole number of 1 or more.`);
  return n;
}
function oneOf(value, name, allowed) {
  if (!allowed.includes(value)) throw new Error(`Input "${name}" must be one of: ${allowed.join(", ")}.`);
  return value;
}
function scanFails(report, failOn) {
  if (failOn === "none") return false;
  const retired = report.models.some((m) => m.status === "retired" || m.status === "rerouted") || report.apis.some((a) => a.daysLeft <= 0);
  if (failOn === "retired") return retired;
  const soon = report.models.some((m) => (m.status === "retiring" || m.status === "rerouting") && (m.daysLeft ?? Infinity) <= SOON_DAYS2) || report.apis.some((a) => a.daysLeft > 0 && a.daysLeft <= SOON_DAYS2);
  return retired || soon;
}
function switchIds(oldModel, newModel) {
  const a = parseModelRef(oldModel);
  const b = parseModelRef(newModel);
  const bare = (m) => m.replace(/^models\//, "");
  const prefix = (m) => bare(m).includes("/") ? bare(m).slice(0, bare(m).lastIndexOf("/")) : "";
  if (a.provider !== b.provider || prefix(a.model) !== prefix(b.model)) {
    throw new Error(`open-pr only switches models within one provider: ${oldModel} to ${newModel} needs different SDK code, so change it by hand.`);
  }
  const last = (m) => m.slice(m.lastIndexOf("/") + 1);
  const ids = checkSwitchIds(last(a.model), last(b.model));
  return prefix(a.model) ? { ...ids, prefix: prefix(a.model) } : ids;
}
async function run({ env, today, log, client, github }) {
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  const summary = async (markdown) => {
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${markdown}

`);
    else log(markdown);
  };
  const failOn = oneOf(input("fail-on", env) || "retired", "fail-on", ["retired", "retiring", "none"]);
  const openPr = oneOf(input("open-pr", env) || "false", "open-pr", ["true", "false"]) === "true";
  const scanRoot = resolve(workspace, input("path", env) || ".");
  const scan = await scanDirectory(scanRoot);
  const report = buildReport(scan, env.GITHUB_REPOSITORY ?? workspace, today);
  const check = buildCheck(report, null);
  await summary(`## AI Change Guard: ${check.title}

${check.summary}`);
  let failed = scanFails(report, failOn);
  log(failed ? `::error::AI Change Guard: ${check.title}` : `AI Change Guard: ${check.title}`);
  const prompts = input("prompts", env);
  const oldModel = input("old-model", env);
  const newModel = input("new-model", env);
  if (openPr && !(prompts && oldModel && newModel)) {
    throw new Error('open-pr needs a replay as proof: set "prompts", "old-model" and "new-model".');
  }
  if (prompts || oldModel || newModel) {
    if (!prompts || !oldModel || !newModel) throw new Error('A replay needs all three inputs: "prompts", "old-model" and "new-model".');
    const ids = openPr ? switchIds(oldModel, newModel) : void 0;
    const plan = ids ? await planSwitch(scanRoot, scan.findings, ids.from, ids.to, ids.prefix ? { prefix: ids.prefix } : {}) : void 0;
    const replayFailOn = oneOf(input("replay-fail-on", env) || "broken", "replay-fail-on", ["broken", "changed", "none"]);
    const runs = positive(input("runs", env) || "3", "runs");
    const repair = oneOf(input("repair", env) || "false", "repair", ["true", "false"]) === "true";
    const concurrency = positive(input("concurrency", env) || "2", "concurrency");
    const maxCalls = positive(input("max-calls", env) || "300", "max-calls");
    const llm = client ?? withRetry(createClient({ env }));
    const items = await loadGoldenSet(resolve(workspace, prompts));
    const job = await runReplayJob({ items, oldModel, newModel, runs, concurrency, maxCalls, client: llm, repair });
    const replay = job.report;
    await summary(formatReplayMarkdown(replay));
    if (job.repair) {
      await summary(formatRepairMarkdown(job.repair));
      const fixed = job.repair.results.filter((r) => r.fixed).length;
      log(`AI Change Guard Prompt Repair: ${fixed} of ${job.repair.results.length} format breaks fixed (${job.repair.calls} extra calls); the fixes are in the Summary`);
    }
    if (job.repairSkipped) log(`::warning::AI Change Guard ${job.repairSkipped}`);
    const { broken, changed } = replay.totals;
    const replayFailed = replayFailOn === "broken" && broken > 0 || replayFailOn === "changed" && broken + changed > 0;
    log(`${replayFailed ? "::error::" : ""}AI Change Guard replay: ${replay.totals.same} same, ${changed} changed, ${broken} broken`);
    failed = failed || replayFailed;
    if (ids && plan) {
      const notice = (text) => log(`::notice::AI Change Guard: ${text}`);
      if (replayFailed || broken > 0 || replay.totals.error > 0) {
        notice("no pull request, because the replay did not pass (see the Summary).");
      } else if (plan.edits.length === 0) {
        notice(`no pull request, because no code uses ${ids.from} as a plain model ID${plan.skipped.length ? ` (${plan.skipped.length} use(s) need a manual change)` : ""}.`);
      } else {
        const token = input("github-token", env) || env.GITHUB_TOKEN || "";
        if (!github && !token) throw new Error('open-pr needs a token: keep the default "github-token" input or pass one.');
        const repo = env.GITHUB_REPOSITORY ?? "";
        const result = await openEvidencePr({
          api: github ?? githubApi(token, env.GITHUB_API_URL),
          repo,
          ref: env.GITHUB_REF ?? "",
          sha: env.GITHUB_SHA ?? "",
          workspace,
          scanPath: relative2(workspace, scanRoot).split(sep2).join("/"),
          plan,
          replay
        });
        if (result.action === "skipped") notice(`no pull request. ${result.reason}`);
        else {
          log(`AI Change Guard ${result.action} pull request #${result.number}: ${result.url}`);
          await summary(`**Evidence pull request ${result.action}:** [#${result.number}](${result.url})`);
        }
      }
    }
  }
  return failed ? 1 : 0;
}
if (process.env.GITHUB_ACTIONS === "true") {
  run({ env: process.env, today: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10), log: (line) => console.log(line) }).then(
    (code3) => {
      process.exitCode = code3;
    },
    (error) => {
      console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  );
}
export {
  input,
  run,
  scanFails,
  switchIds
};
