// action/src/main.ts
import { appendFile, readFile as readFile5 } from "node:fs/promises";
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
function judgeItem(item, records, options = {}) {
  const share = options.share ?? 0.4;
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
  if (newErrors >= atLeast(newRecords.length, share)) {
    add("calls-failing", "broken", `${newErrors} of ${newRecords.length} calls to the new model failed: ${firstError(newRecords)}`);
  }
  const threshold = atLeast(newOk.length, share);
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

// packages/catalog/dist/index.js
import { readFileSync } from "node:fs";
function load(file) {
  return JSON.parse(readFileSync(new URL(`../data/${file}`, import.meta.url), "utf8"));
}
var models = load("models.json").models;
var apis = load("apis.json").apis;
var priceData = load("prices.json");
var prices = priceData.prices;
var priceChanges = priceData.changes;
var tokenizers = priceData.tokenizers;
var packageData = load("packages.json");
var compromisedReleases = packageData.compromised;
var aiNames = { npm: new Set(packageData.ai.npm.names), PyPI: new Set(packageData.ai.PyPI.names) };
function aiPackageMatch(ecosystem, name) {
  const rules = packageData.ai[ecosystem];
  if (aiNames[ecosystem].has(name))
    return "name";
  return rules.prefixes.some((p) => name.startsWith(p)) ? "prefix" : void 0;
}
function findCompromised(ecosystem, name, version) {
  return compromisedReleases.find((c) => c.ecosystem === ecosystem && c.name === name && c.versions.includes(version));
}
var defaultPlatform = {
  openai: "openai-api",
  anthropic: "anthropic-api",
  google: "gemini-api",
  mistral: "mistral-api"
};
function lookupModel(id) {
  return models.filter((m) => m.id === id);
}
function lookupPrice(id, platform) {
  return prices.find((p) => p.id === id && p.platform === platform);
}
function lookupPriceChanges(id, platform) {
  return priceChanges.filter((c) => c.id === id && c.platform === platform).sort((a, b) => a.on.localeCompare(b.on));
}
function priceOn(id, platform, date) {
  const base = lookupPrice(id, platform);
  if (!base)
    return void 0;
  let price = { input: base.input, output: base.output };
  for (const change2 of lookupPriceChanges(id, platform)) {
    if (change2.on > date)
      break;
    if (change2.input === void 0 || change2.output === void 0)
      return void 0;
    price = { input: change2.input, output: change2.output };
  }
  return price;
}
function tokenRatio(from, to) {
  const a = lookupPrice(from.id, from.platform)?.tokenizer;
  const b = lookupPrice(to.id, to.platform)?.tokenizer;
  if (!a || !b || a === b)
    return 1;
  const forward = tokenizers.find((t) => t.id === b && t.relativeTo === a);
  if (forward)
    return forward.ratio;
  const back = tokenizers.find((t) => t.id === a && t.relativeTo === b);
  return back ? 1 / back.ratio : 1;
}
function billedPriceOn(id, platform, date) {
  const reroute = models.find((m) => m.id === id && m.platform === platform && m.reroutesTo && m.retiresOn <= date);
  return reroute?.reroutesTo ? priceOn(reroute.reroutesTo, platform, date) : priceOn(id, platform, date);
}
function localToday() {
  return (/* @__PURE__ */ new Date()).toLocaleDateString("en-CA");
}
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);
}
function formatUsd(amount) {
  const abs = Math.abs(amount);
  const text = abs >= 0.1 || abs === 0 ? abs.toFixed(2) : abs.toFixed(6).replace(/(\.\d\d\d*?)0+$/, "$1");
  return `${amount < 0 ? "-" : ""}$${text}`;
}
function callCost(price, inputTokens, outputTokens) {
  return (inputTokens * price.input + outputTokens * price.output) / 1e6;
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
function platformForRef(ref) {
  const provider = ref.slice(0, ref.indexOf(":"));
  return Object.hasOwn(defaultPlatform, provider) ? defaultPlatform[provider] : void 0;
}
function costOfCall(ref, usage, today) {
  const platform = platformForRef(ref);
  const price = platform ? billedPriceOn(modelName(ref), platform, today) : void 0;
  return price ? callCost(price, usage.input, usage.output) : void 0;
}
function buildReplayReport(items, records, options) {
  const results = items.map((item) => judgeItem(item, records, options.judge)).sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict]);
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
  const today = options.today ?? localToday();
  const avgTokens = { old: usage("old"), new: usage("new") };
  const oldCost = paired.length ? costOfCall(options.oldModel, avgTokens.old, today) : void 0;
  const newCost = paired.length ? costOfCall(options.newModel, avgTokens.new, today) : void 0;
  return {
    oldModel: options.oldModel,
    newModel: options.newModel,
    runs: options.runs,
    calls: records.length,
    failedCalls: records.filter((r) => r.error).length,
    totals,
    avgTokens,
    avgLatencyMs: { old: average2(paired.map((r) => r.old.avgLatencyMs)), new: average2(paired.map((r) => r.new.avgLatencyMs)) },
    ...oldCost !== void 0 || newCost !== void 0 ? { costPerCall: { ...oldCost !== void 0 ? { old: oldCost } : {}, ...newCost !== void 0 ? { new: newCost } : {} } } : {},
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
function costLine(report) {
  const c = report.costPerCall;
  if (!c)
    return "";
  const side = (v) => v === void 0 ? "no list price known" : formatUsd(v);
  const pct = c.old !== void 0 && c.new !== void 0 ? change(c.old, c.new) : "";
  return `Cost per call at list price: ${side(c.old)} \u2192 ${side(c.new)}${pct}`;
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
  const cost = costLine(report);
  if (cost)
    out.push("", `${cost}.`);
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

// packages/replay/dist/watch.js
import { createHash } from "node:crypto";
var BASELINE_VERSION = 1;
var MAX_TEXT = 32e3;
var WATCH_SHARE = 0.6;
function stable(value) {
  if (Array.isArray(value))
    return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function itemHash(item) {
  const request = { system: item.system, messages: item.messages, tools: item.tools, maxTokens: item.maxTokens, temperature: item.temperature, jsonMode: item.jsonMode };
  return createHash("sha256").update(stable(request)).digest("hex").slice(0, 16);
}
function trimmed(response) {
  return response.text.length > MAX_TEXT ? { ...response, text: response.text.slice(0, MAX_TEXT) } : response;
}
function parseBaseline(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("The baseline file is not valid JSON.");
  }
  if (data?.version !== BASELINE_VERSION || typeof data.model !== "string" || !Array.isArray(data.records) || !Array.isArray(data.items)) {
    throw new Error("This is not an AI Change Guard baseline file (or it was made by a newer version).");
  }
  return data;
}
async function runWatch(options) {
  const { baseline } = options;
  const known = new Map(baseline.items.map((i) => [i.id, i.hash]));
  const watched = options.items.filter((i) => known.get(i.id) === itemHash(i));
  const notInBaseline = options.items.filter((i) => known.get(i.id) !== itemHash(i)).map((i) => i.id);
  if (watched.length === 0)
    throw new Error("None of these prompts match the baseline. Make a new baseline for this golden set.");
  const runs = options.runs ?? baseline.runs;
  const live = await runReplay({
    items: watched,
    oldModel: baseline.model,
    newModel: baseline.model,
    runs,
    client: options.client,
    sides: ["new"],
    ...options.concurrency ? { concurrency: options.concurrency } : {},
    ...options.maxCalls ? { maxCalls: options.maxCalls } : {},
    ...options.signal ? { signal: options.signal } : {},
    ...options.onProgress ? { onProgress: options.onProgress } : {}
  });
  for (const r of live)
    if (r.response)
      r.response = trimmed(r.response);
  const ids = new Set(watched.map((i) => i.id));
  const stored = baseline.records.filter((r) => ids.has(r.itemId)).map((r) => ({ itemId: r.itemId, side: "old", run: r.run, ...r.response ? { response: r.response } : { error: r.error ?? "failed" } }));
  const report = buildReplayReport(watched, [...stored, ...live], { oldModel: baseline.model, newModel: baseline.model, runs, judge: { share: WATCH_SHARE } });
  const served = (records) => [...new Set(records.flatMap((r) => r.response?.servedModel ? [r.response.servedModel] : []))].sort();
  const servedBefore = served(stored);
  const servedNow = served(live);
  const requested = modelName(baseline.model);
  const isNew = (s) => !servedBefore.includes(s);
  const reroutes = servedNow.filter((s) => isNew(s) && isReroute(requested, s)).map((s) => ({ requested, served: s }));
  const snapshotChanged = servedBefore.length > 0 && servedNow.some(isNew);
  const alert = report.totals.broken + report.totals.changed + report.totals.error > 0 || reroutes.length > 0 || snapshotChanged;
  return { model: baseline.model, baselineCreatedAt: baseline.createdAt, report, reroutes, servedBefore, servedNow, snapshotChanged, notInBaseline, alert };
}
function headline(w) {
  const t = w.report.totals;
  const n = w.report.items.length;
  if (!w.alert)
    return `No change: ${n} prompt${n === 1 ? "" : "s"} on ${w.model} still answer like the baseline of ${w.baselineCreatedAt.slice(0, 10)}.`;
  const parts = [];
  if (t.broken)
    parts.push(`${t.broken} broken`);
  if (t.changed)
    parts.push(`${t.changed} changed`);
  if (t.error)
    parts.push(`${t.error} could not be compared`);
  if (w.reroutes.length)
    parts.push(`rerouted to ${w.reroutes.map((r) => r.served).join(", ")}`);
  if (w.snapshotChanged)
    parts.push(`now served by ${w.servedNow.join(", ")} (was ${w.servedBefore.join(", ")})`);
  return `${w.model} changed since the baseline of ${w.baselineCreatedAt.slice(0, 10)}: ${parts.join(", ")}.`;
}
function formatWatchMarkdown(w) {
  const t = w.report.totals;
  const lines = [
    `## ${w.alert ? "AI model watch: change detected" : "AI model watch: no change"}`,
    "",
    headline(w),
    "",
    "| Same | Changed | Broken | Could not compare |",
    "| ---: | ---: | ---: | ---: |",
    `| ${t.same} | ${t.changed} | ${t.broken} | ${t.error} |`
  ];
  const changed = w.report.items.filter((i) => i.verdict !== "same");
  if (changed.length) {
    lines.push("", "| Prompt | Verdict | Why |", "| --- | --- | --- |");
    for (const i of changed) {
      const why = (i.reasons.map((r) => r.detail).join("; ") || i.error || "").replace(/\s+/g, " ").replace(/\|/g, "\\|");
      lines.push(`| ${i.id.replace(/\|/g, "\\|")} | ${i.verdict} | ${why} |`);
    }
  }
  if (w.servedNow.length)
    lines.push("", `Served by: ${w.servedNow.join(", ")}${w.servedBefore.length ? ` (at baseline: ${w.servedBefore.join(", ")})` : ""}.`);
  if (w.notInBaseline.length)
    lines.push("", `Not watched (new or edited since the baseline): ${w.notInBaseline.join(", ")}.`);
  return lines.join("\n");
}
function slackMessage(w, link) {
  const ids = w.report.items.filter((i) => i.verdict === "broken" || i.verdict === "changed").map((i) => `${i.id} (${i.verdict})`);
  const text = [`:rotating_light: ${headline(w)}`, ids.length ? `Prompts: ${ids.slice(0, 20).join(", ")}${ids.length > 20 ? ", \u2026" : ""}` : "", link ? `Details: ${link}` : ""].filter(Boolean).join("\n");
  return { text };
}
async function postSlack(webhookUrl, message, fetchImpl = fetch) {
  if (!/^https:\/\//.test(webhookUrl))
    throw new Error("The Slack webhook must be an https URL.");
  const res = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(1e4)
  });
  if (!res.ok)
    throw new Error(`Slack answered ${res.status}.`);
}

// packages/replay/dist/fallback.js
function plannedFallbackCalls(items, runs, candidates3) {
  return plannedCalls(items, runs, 1) * (1 + candidates3);
}
function cleanCandidates(primary, candidates3) {
  return [...new Set(candidates3.map((c) => c.trim()).filter(Boolean))].filter((c) => c !== primary);
}
var ANY_RUN = 0.01;
async function testFallbacks(options) {
  const { primary, client } = options;
  const runs = options.runs ?? 3;
  const maxCalls = options.maxCalls ?? 500;
  parseModelRef(primary);
  const candidates3 = cleanCandidates(primary, options.candidates);
  candidates3.forEach((c) => parseModelRef(c));
  if (candidates3.length === 0)
    throw new Error("Give at least one candidate model that differs from the primary.");
  const planned = plannedFallbackCalls(options.items.length, runs, candidates3.length);
  if (planned > maxCalls) {
    throw new SpendCapError(`Testing ${candidates3.length} candidates needs ${planned} calls, above the limit of ${maxCalls}. Use fewer candidates or runs, or raise the limit.`);
  }
  const common = { client, runs, ...options.concurrency ? { concurrency: options.concurrency } : {}, ...options.signal ? { signal: options.signal } : {} };
  const primaryRecords = await runReplay({ ...common, items: options.items, oldModel: primary, newModel: primary, sides: ["old"], maxCalls });
  const answered = new Set(primaryRecords.filter((r) => r.response).map((r) => r.itemId));
  if (answered.size === 0) {
    throw new Error(`${primary} did not answer any prompt (${primaryRecords[0]?.error ?? "no calls"}). Fix that first: backups are judged against its answers.`);
  }
  const items = options.items.filter((i) => answered.has(i.id));
  const skippedPrompts = options.items.filter((i) => !answered.has(i.id)).map((i) => i.id);
  const perCandidate = plannedCalls(items.length, runs, 1);
  const results = await Promise.all(candidates3.map(async (model) => {
    const records = await runReplay({ ...common, items, oldModel: primary, newModel: model, sides: ["new"], maxCalls: perCandidate });
    const report = buildReplayReport(items, [...primaryRecords, ...records], { oldModel: primary, newModel: model, runs, judge: { share: ANY_RUN }, ...options.today ? { today: options.today } : {} });
    const t = report.totals;
    const rerouted = report.reroutes.filter((r) => r.side === "new");
    const reason = records.length > 0 && records.every((r) => r.error) ? `every call failed: ${(records[0].error ?? "").slice(0, 120)}` : rerouted.length > 0 ? `served as ${rerouted.map((r) => r.served).join(", ")}, not the model requested` : t.broken > 0 ? `${t.broken} prompt${t.broken === 1 ? "" : "s"} broken in at least one run` : t.error > 0 ? `${t.error} prompt${t.error === 1 ? "" : "s"} could not be compared` : void 0;
    return { model, report, qualifies: !reason, ...reason ? { reason } : {}, calls: records.length };
  }));
  const fallbacks = results.filter((r) => r.qualifies).sort((a, b) => a.report.totals.changed - b.report.totals.changed || a.report.avgLatencyMs.new - b.report.avgLatencyMs.new).map((r) => r.model);
  return {
    primary,
    runs,
    calls: primaryRecords.length + results.reduce((n, r) => n + r.calls, 0),
    candidates: results.map(({ calls: _calls, ...r }) => r),
    fallbacks,
    skippedPrompts
  };
}

// packages/replay/dist/savings.js
var MAX_CHANGED_SHARE = 0.02;
var MIN_SAVING = 0.05;
var PRICE_HORIZON_DAYS = 60;
var RETIREMENT_DAYS = 90;
var DEFAULT_TOKENS = { input: 1e3, output: 250 };
function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
}
function steadyPrice(id, platform, today) {
  const now = billedPriceOn(id, platform, today);
  const later = billedPriceOn(id, platform, addDays(today, PRICE_HORIZON_DAYS));
  if (!now || !later)
    return void 0;
  return { input: Math.max(now.input, later.input), output: Math.max(now.output, later.output) };
}
function candidateProblem(ref, today) {
  const platform = platformForRef(ref);
  const id = modelName(ref);
  if (!platform)
    return "not priced in the catalog (a gateway or unknown provider)";
  if (/preview/.test(id))
    return "a preview model";
  if (/-\d{8}$|-\d{4}-\d{2}-\d{2}$/.test(id))
    return "a dated snapshot ID; test its alias instead";
  const retiring = lookupModel(id).find((m) => m.platform === platform && m.retiresOn <= addDays(today, RETIREMENT_DAYS));
  if (retiring)
    return `${retiring.reroutesTo ? "reroutes" : "retires"} on ${retiring.retiresOn}`;
  if (!steadyPrice(id, platform, today))
    return "its price two months from now is not known";
  return void 0;
}
function steadyCost(ref, tokens, today) {
  const platform = platformForRef(ref);
  const price = platform ? steadyPrice(modelName(ref), platform, today) : void 0;
  return price ? callCost(price, tokens.input, tokens.output) : void 0;
}
function cheaperCandidates(primary, today, options = {}) {
  const { provider } = parseModelRef(primary);
  const platform = platformForRef(primary);
  if (!platform)
    return [];
  const id = modelName(primary);
  const tokens = options.tokens ?? DEFAULT_TOKENS;
  const current = steadyPrice(id, platform, today) ?? billedPriceOn(id, platform, today);
  if (!current)
    return [];
  const currentCost = callCost(current, tokens.input, tokens.output);
  const out = [];
  for (const p of prices) {
    if (p.platform !== platform || p.id === id)
      continue;
    if (candidateProblem(`${provider}:${p.id}`, today))
      continue;
    const price = steadyPrice(p.id, platform, today);
    const ratio = tokenRatio({ id, platform }, { id: p.id, platform });
    const cost = callCost(price, tokens.input * ratio, tokens.output * ratio);
    if (cost <= currentCost * (1 - MIN_SAVING))
      out.push({ ref: `${provider}:${p.id}`, costPerCall: cost });
  }
  return out.sort((a, b) => b.costPerCall - a.costPerCall).slice(0, options.count ?? 2);
}
async function findSavings(options) {
  const today = options.today ?? localToday();
  const runs = options.runs ?? 3;
  const asked = options.candidates ?? cheaperCandidates(options.primary, today).map((c) => c.ref);
  const excluded = asked.flatMap((model) => {
    const reason = candidateProblem(model, today);
    return reason ? [{ model, reason }] : [];
  });
  const candidates3 = asked.filter((m) => !excluded.some((e) => e.model === m));
  const base = { primary: options.primary, runs, excluded, ...options.callsPerMonth !== void 0 ? { callsPerMonth: options.callsPerMonth } : {} };
  if (candidates3.length === 0)
    return { ...base, calls: 0, candidates: [], skippedPrompts: [] };
  const tested = await testFallbacks({
    items: options.items,
    primary: options.primary,
    candidates: candidates3,
    client: options.client,
    runs,
    ...options.concurrency ? { concurrency: options.concurrency } : {},
    ...options.maxCalls ? { maxCalls: options.maxCalls } : {},
    ...options.signal ? { signal: options.signal } : {},
    today
  });
  const results = tested.candidates.map((c) => {
    const compared = c.report.items.length || 1;
    const changedShare = c.report.totals.changed / compared;
    const current = steadyCost(options.primary, c.report.avgTokens.old, today) ?? c.report.costPerCall?.old;
    const candidate = steadyCost(c.model, c.report.avgTokens.new, today);
    const priced = current !== void 0 && candidate !== void 0 && c.report.comparedPrompts > 0 ? { current, candidate } : void 0;
    const savingShare = priced && priced.current > 0 ? 1 - priced.candidate / priced.current : void 0;
    const reason = c.reason ?? (changedShare > MAX_CHANGED_SHARE ? `${c.report.totals.changed} of ${compared} prompts answered differently (more than ${Math.round(MAX_CHANGED_SHARE * 100)}%)` : !priced || savingShare === void 0 ? "no list price known for one of the two models" : savingShare < 0 ? `costs more on your prompts (+${Math.round(-savingShare * 100)}% per call)` : savingShare < MIN_SAVING ? `only ${Math.round(savingShare * 100)}% cheaper on your prompts` : void 0);
    return {
      model: c.model,
      qualifies: !reason,
      ...reason ? { reason } : {},
      report: c.report,
      changedShare,
      ...priced ? { costPerCall: priced } : {},
      ...savingShare !== void 0 ? { savingShare } : {},
      ...priced && options.callsPerMonth !== void 0 ? { monthlySaving: (priced.current - priced.candidate) * options.callsPerMonth } : {}
    };
  });
  const best = results.filter((r) => r.qualifies).sort((a, b) => (b.savingShare ?? 0) - (a.savingShare ?? 0))[0];
  return { ...base, calls: tested.calls, candidates: results, skippedPrompts: tested.skippedPrompts, ...best ? { best } : {} };
}
function usd(amount) {
  return amount >= 100 ? `$${Math.round(amount).toLocaleString("en-US")}` : formatUsd(amount);
}
function verdictLine(c) {
  const t = c.report.totals;
  return `${t.same} same \xB7 ${t.changed} changed \xB7 ${t.broken} broken on ${c.report.items.length} prompts`;
}
function savingText(c) {
  if (!c.costPerCall || c.savingShare === void 0)
    return "";
  const pct = Math.round(c.savingShare * 100);
  const month = c.monthlySaving !== void 0 ? `, about ${usd(c.monthlySaving)} a month` : "";
  return `${pct}% cheaper per call (${usd(c.costPerCall.current)} \u2192 ${usd(c.costPerCall.candidate)})${month}`;
}
function skippedNote(result) {
  const n = result.skippedPrompts.length;
  return n ? `${result.primary} did not answer ${n} prompt${n === 1 ? "" : "s"} (${result.skippedPrompts.slice(0, 5).join(", ")}${n > 5 ? ", ..." : ""}), so ${n === 1 ? "it was" : "they were"} not compared.` : void 0;
}
function formatSavingsMarkdown(result) {
  const out = [`## Money-Finder: \`${result.primary}\``, ""];
  if (result.candidates.length === 0) {
    return [...out, "No cheaper model on the same provider to test.", ...result.excluded.map((e) => `- Not tested: \`${e.model}\`: ${e.reason}`)].join("\n");
  }
  if (result.best) {
    out.push(`**Switch to \`${result.best.model}\`: ${savingText(result.best)}.**`, "", `On your real prompts: ${verdictLine(result.best)}, ${result.runs} runs each.`);
  } else {
    out.push("**No cheaper model answered your prompts the same way.** Keep the model you have.");
  }
  out.push("", "| Candidate | Result | Cost per call |", "| --- | --- | --- |");
  for (const c of result.candidates) {
    const cost = c.costPerCall ? `${usd(c.costPerCall.current)} \u2192 ${usd(c.costPerCall.candidate)}` : "unknown";
    out.push(`| \`${c.model}\` | ${c.qualifies ? `Passes: ${verdictLine(c)}` : `Skipped: ${c.reason}`} | ${cost} |`);
  }
  for (const e of result.excluded)
    out.push(`| \`${e.model}\` | Not tested: ${e.reason} | |`);
  const skipped = skippedNote(result);
  if (skipped)
    out.push("", `> **Warning:** ${skipped}`);
  out.push("", "List prices at the higher of today's and the price two months out; no batch, cache or volume discounts.");
  return out.join("\n");
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
import { join as join2 } from "node:path";

// packages/scanner/dist/deps.js
import { basename } from "node:path";
var LOCKFILES = /* @__PURE__ */ new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock", "uv.lock", "Pipfile.lock"]);
function isLockfile(name) {
  return LOCKFILES.has(basename(name));
}
function isDependencyFile(name) {
  const base = basename(name);
  return LOCKFILES.has(base) || base === "package.json" || /^requirements[\w.-]*\.txt$/i.test(base);
}
function normalizeName(ecosystem, name) {
  return ecosystem === "PyPI" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name;
}
var EXACT_VERSION = /^v?(\d+\.\d+(?:\.\d+)?(?:[-.+]?[0-9A-Za-z.]+)?)$/;
var NOT_REGISTRY = /^(workspace:|file:|link:|portal:|git\+|git:|github:|gitlab:|bitbucket:|https?:)/;
function fromPackageLock(content) {
  const data = JSON.parse(content);
  const out = [];
  if (data.packages) {
    for (const [path, info] of Object.entries(data.packages)) {
      const at = path.lastIndexOf("node_modules/");
      if (at < 0 || info.link)
        continue;
      const name = info.name ?? path.slice(at + "node_modules/".length);
      if (name && info.version)
        out.push({ name, version: info.version, needle: `"${path}"` });
    }
    return out;
  }
  const walk2 = (deps) => {
    for (const [name, value] of Object.entries(deps ?? {})) {
      const info = value;
      if (info.version)
        out.push({ name, version: info.version, needle: `"${name}"` });
      walk2(info.dependencies);
    }
  };
  walk2(data.dependencies);
  return out;
}
function fromPackageJson(content) {
  const data = JSON.parse(content);
  const out = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = data[field];
    if (!deps || typeof deps !== "object")
      continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== "string" || NOT_REGISTRY.test(spec.trim()))
        continue;
      const alias = aliasTarget(spec.trim());
      const exact = EXACT_VERSION.exec((alias ? alias.spec : spec.trim()).replace(/^=/, ""));
      out.push({ name: alias?.name ?? name, ...exact ? { version: exact[1] } : {}, needle: `"${name}"` });
    }
  }
  return out;
}
function aliasTarget(spec) {
  if (!spec.startsWith("npm:"))
    return void 0;
  const rest = spec.slice(4);
  if (!rest || /^[\d~^<>=*]/.test(rest))
    return void 0;
  const at = rest.indexOf("@", 1);
  return at < 0 ? { name: rest, spec: "" } : { name: rest.slice(0, at), spec: rest.slice(at + 1) };
}
function fromPnpmLock(content) {
  const out = [];
  const re = /^ {2}['"]?\/?((?:@[^/@\s'"]+\/)?[^/@\s'"]+)[@/](\d[^\s:'"(_]*)/gm;
  for (const m of content.matchAll(re))
    out.push({ name: m[1], version: m[2], needle: m[0] });
  return out;
}
function fromYarnLock(content) {
  const out = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    if (!header || header.startsWith(" ") || header.startsWith("#") || !header.endsWith(":"))
      continue;
    const first = header.replace(/:$/, "").split(",")[0].trim().replace(/^"|"$/g, "");
    const at = first.indexOf("@", 1);
    if (at < 1)
      continue;
    const rest = first.slice(at + 1);
    const name = rest.startsWith("npm:") ? aliasTarget(rest)?.name ?? first.slice(0, at) : first.slice(0, at);
    for (let j = i + 1; j < lines.length && lines[j].startsWith(" "); j++) {
      const v = /^\s+version:?\s+"?([^"\s]+)"?/.exec(lines[j]);
      if (v) {
        out.push({ name, version: v[1], needle: header });
        break;
      }
    }
  }
  return out;
}
var LOCAL_SOURCE = /^source\s*=\s*\{[^}]*\b(editable|virtual|directory|path|git)\s*=|^\[package\.source\][^[]*?^type\s*=\s*"(directory|file|git|url)"/ms;
var OTHER_INDEX = /^source\s*=\s*\{\s*registry\s*=\s*"(?!https:\/\/pypi\.org\/)/m;
function fromTomlLock(content) {
  const out = [];
  for (const block of content.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    if (LOCAL_SOURCE.test(block))
      continue;
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name)
      out.push({ name, ...version ? { version } : {}, needle: `name = "${name}"`, ...OTHER_INDEX.test(block) ? { privateIndex: true } : {} });
  }
  return out;
}
function fromPipfileLock(content) {
  const data = JSON.parse(content);
  const out = [];
  for (const section of ["default", "develop"]) {
    for (const [name, info] of Object.entries(data[section] ?? {})) {
      const version = info?.version?.replace(/^==/, "");
      out.push({ name, ...version ? { version } : {}, needle: `"${name}"` });
    }
  }
  return out;
}
function fromRequirements(content) {
  const out = [];
  const privateIndex = /^\s*(--index-url|--extra-index-url|-i\s)/m.test(content);
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("-"))
      continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(?:===?\s*([^\s;,]+))?/.exec(line);
    if (m)
      out.push({ name: m[1], ...m[2] && !m[2].includes("*") ? { version: m[2] } : {}, needle: raw, ...privateIndex ? { privateIndex } : {} });
  }
  return out;
}
function parseDependencies(file, text) {
  const base = basename(file);
  const content = text.replace(/\r\n?/g, "\n");
  let ecosystem;
  let raw;
  try {
    if (base === "package-lock.json" || base === "npm-shrinkwrap.json")
      [ecosystem, raw] = ["npm", fromPackageLock(content)];
    else if (base === "package.json")
      [ecosystem, raw] = ["npm", fromPackageJson(content)];
    else if (base === "pnpm-lock.yaml")
      [ecosystem, raw] = ["npm", fromPnpmLock(content)];
    else if (base === "yarn.lock")
      [ecosystem, raw] = ["npm", fromYarnLock(content)];
    else if (base === "poetry.lock" || base === "uv.lock")
      [ecosystem, raw] = ["PyPI", fromTomlLock(content)];
    else if (base === "Pipfile.lock")
      [ecosystem, raw] = ["PyPI", fromPipfileLock(content)];
    else if (/^requirements[\w.-]*\.txt$/i.test(base))
      [ecosystem, raw] = ["PyPI", fromRequirements(content)];
    else
      return [];
  } catch {
    return [];
  }
  return raw.map((r) => ({
    ecosystem,
    name: normalizeName(ecosystem, r.name),
    ...r.version ? { version: r.version } : {},
    file,
    needle: r.needle,
    ...r.privateIndex ? { privateIndex: r.privateIndex } : {}
  }));
}
function ownPackageName(file, content) {
  if (basename(file) !== "package.json")
    return void 0;
  try {
    const name = JSON.parse(content).name;
    return typeof name === "string" ? name : void 0;
  } catch {
    return void 0;
  }
}
function privateRegistries(npmrc) {
  const all = /^\s*registry\s*=/m.test(npmrc);
  const scopes = [...npmrc.matchAll(/^\s*(@[^:\s]+):registry\s*=/gm)].map((m) => m[1]);
  return { all, scopes };
}
function lineOf(content, needle) {
  const at = content.indexOf(needle);
  if (at < 0)
    return 1;
  let line = 1;
  for (let i = content.indexOf("\n"); i >= 0 && i < at; i = content.indexOf("\n", i + 1))
    line++;
  return line;
}

// packages/scanner/dist/packages.js
var AI_LOOKING = /(openai|anthropic|claude|gemini|gpt|llm|langchain|langgraph|llama|mistral|ollama|genai|mcp|agent|copilot|huggingface)/i;
function looksLikeAiPackage(name) {
  return AI_LOOKING.test(name);
}
function isAiRelated(ecosystem, name) {
  return aiPackageMatch(ecosystem, name) !== void 0 || looksLikeAiPackage(name);
}
function aiPackagesOf(deps) {
  const byName = /* @__PURE__ */ new Map();
  for (const d of deps) {
    if (!isAiRelated(d.ecosystem, d.name))
      continue;
    const known = aiPackageMatch(d.ecosystem, d.name) === "name";
    const key = `${d.ecosystem}|${d.name}`;
    const pkg = byName.get(key) ?? { ecosystem: d.ecosystem, name: d.name, versions: [], known, locations: [] };
    if (d.version && !pkg.versions.includes(d.version))
      pkg.versions.push(d.version);
    if (d.privateIndex)
      pkg.privateIndex = true;
    const location = `${d.file}:${d.line}`;
    if (!pkg.locations.includes(location))
      pkg.locations.push(location);
    byName.set(key, pkg);
  }
  return [...byName.values()].sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name));
}
function compromisedRow(pkg, version, release) {
  return {
    ecosystem: pkg.ecosystem,
    name: pkg.name,
    version,
    issue: "compromised",
    advisory: release.advisory,
    summary: release.summary,
    url: release.sources[0]?.url ?? `https://osv.dev/vulnerability/${release.advisory}`,
    date: release.published,
    source: "catalog",
    locations: pkg.locations
  };
}
function checkPackagesOffline(packages) {
  const rows = [];
  for (const pkg of packages) {
    for (const version of pkg.versions) {
      const release = findCompromised(pkg.ecosystem, pkg.name, version);
      if (release)
        rows.push(compromisedRow(pkg, version, release));
    }
  }
  return rows;
}
var DAY_MS = 864e5;
async function getJson(fetchFn, url, timeoutMs, init) {
  const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json", ...init?.body ? { "Content-Type": "application/json" } : {} } });
  if (res.status === 404)
    return { status: 404 };
  if (!res.ok)
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return { status: res.status, body: await res.json() };
}
async function firstPublished(fetchFn, pkg, timeoutMs) {
  if (pkg.ecosystem === "npm") {
    const r2 = await getJson(fetchFn, `https://registry.npmjs.org/${pkg.name.replace("/", "%2F")}`, timeoutMs);
    if (r2.status === 404)
      return "missing";
    const created = r2.body?.time?.created;
    return typeof created === "string" ? created : void 0;
  }
  const r = await getJson(fetchFn, `https://pypi.org/pypi/${encodeURIComponent(pkg.name)}/json`, timeoutMs);
  if (r.status === 404)
    return "missing";
  const releases = r.body?.releases ?? {};
  const times = Object.values(releases).flatMap((files) => files.map((f) => f.upload_time_iso_8601).filter((t) => typeof t === "string"));
  return times.sort()[0];
}
async function checkPackagesOnline(packages, options) {
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1e4;
  const rows = [];
  let failed = 0;
  const queries = packages.flatMap((pkg) => pkg.versions.map((version) => ({ pkg, version })));
  if (queries.length > 0) {
    try {
      const batch = await getJson(fetchFn, "https://api.osv.dev/v1/querybatch", timeoutMs, {
        method: "POST",
        body: JSON.stringify({ queries: queries.map((q) => ({ package: { name: q.pkg.name, ecosystem: q.pkg.ecosystem }, version: q.version })) })
      });
      const results = batch.body?.results;
      if (!results)
        throw new Error("OSV answered without results");
      for (let i = 0; i < queries.length; i++) {
        const { pkg, version } = queries[i];
        if (findCompromised(pkg.ecosystem, pkg.name, version))
          continue;
        const malicious = (results[i]?.vulns ?? []).filter((v) => v.id.startsWith("MAL-"));
        for (const v of malicious) {
          const detail = await getJson(fetchFn, `https://api.osv.dev/v1/vulns/${encodeURIComponent(v.id)}`, timeoutMs).catch(() => ({ status: 0 }));
          const vuln = detail.body;
          rows.push({
            ecosystem: pkg.ecosystem,
            name: pkg.name,
            version,
            issue: "compromised",
            advisory: v.id,
            summary: vuln?.summary ?? `Malicious code in ${pkg.name} ${version}.`,
            url: `https://osv.dev/vulnerability/${v.id}`,
            ...vuln?.published ? { date: vuln.published.slice(0, 10) } : {},
            source: "osv",
            locations: pkg.locations
          });
        }
      }
    } catch {
      failed++;
    }
  }
  const newDays = options.newDays ?? NEW_PACKAGE_DAYS;
  const unknown = packages.filter((p) => !p.known).slice(0, options.maxLookups ?? 30);
  const todayMs = Date.parse(`${options.today}T00:00:00Z`);
  for (let i = 0; i < unknown.length; i += 5) {
    await Promise.all(unknown.slice(i, i + 5).map(async (pkg) => {
      const scope = pkg.ecosystem === "npm" && pkg.name.startsWith("@") ? pkg.name.split("/")[0] + "/" : void 0;
      if (pkg.privateIndex || scope !== void 0 && aiPackageMatch("npm", pkg.name) !== "prefix")
        return;
      let first;
      try {
        first = await firstPublished(fetchFn, pkg, timeoutMs);
      } catch {
        failed++;
        return;
      }
      if (first === "missing") {
        rows.push({
          ecosystem: pkg.ecosystem,
          name: pkg.name,
          issue: "not-found",
          // Only a scope's owner can publish under it; an unscoped name is open to anyone.
          summary: `${pkg.name} is not on ${pkg.ecosystem === "npm" ? "npm" : "PyPI"}. If an AI assistant suggested it, the name may be invented${scope ? "" : ", and anyone could publish a package under it"}.`,
          source: "registry",
          locations: pkg.locations
        });
      } else if (first && todayMs - Date.parse(first) < newDays * DAY_MS) {
        const date = first.slice(0, 10);
        rows.push({
          ecosystem: pkg.ecosystem,
          name: pkg.name,
          issue: "new-package",
          summary: `${pkg.name} was first published on ${date}. A brand-new package with an AI-sounding name can be a fake; check its source and owner before installing.`,
          date,
          source: "registry",
          locations: pkg.locations
        });
      }
    }));
  }
  return { rows, failed };
}
var ISSUE_ORDER = { compromised: 0, "not-found": 1, "new-package": 2 };
function packageRowKey(row) {
  return `${row.ecosystem}|${row.name}|${row.version ?? ""}|${row.issue}`;
}
function sortPackageRows(rows) {
  const byKey = /* @__PURE__ */ new Map();
  for (const row of [...rows].sort((a, b) => Number(b.source === "catalog") - Number(a.source === "catalog"))) {
    if (!byKey.has(packageRowKey(row)))
      byKey.set(packageRowKey(row), row);
  }
  return [...byKey.values()].sort((a, b) => ISSUE_ORDER[a.issue] - ISSUE_ORDER[b.issue] || a.name.localeCompare(b.name));
}
var NEW_PACKAGE_DAYS = 30;
function describePackage(row) {
  const what = `${row.name}${row.version ? ` ${row.version}` : ""} (${row.ecosystem})`;
  if (row.issue === "compromised")
    return `${what}: release published with malicious code [${row.advisory}]. ${row.summary}`;
  return `${what}: ${row.summary}`;
}
var PACKAGE_FIX = {
  compromised: "Remove this version and install a clean one. Treat any machine or CI runner that installed it as compromised: rotate every key and token it could read, from a different machine.",
  "not-found": "Check the name against the provider's official docs; remove it or replace it with the real package.",
  "new-package": "Confirm the package's source repository and owner before installing; prefer the provider's official SDK."
};

// packages/scanner/dist/security.js
import { basename as basename3 } from "node:path";

// packages/scanner/dist/walk.js
import { readdir } from "node:fs/promises";
import { basename as basename2, extname, join, relative, sep } from "node:path";
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
  const base = basename2(name);
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
      if (isLockfile(entry.name)) {
        yield { path: full, rel: relative(root, full).split(sep).join("/"), kind: "config", lock: true };
        continue;
      }
      const kind = fileKind(entry.name);
      if (kind)
        yield { path: full, rel: relative(root, full).split(sep).join("/"), kind };
    }
  }
}

// packages/scanner/dist/prompts.js
var MIN_CHARS = 30;
var MAX_CHARS = 8e3;
var Q3 = "'''";
var OPEN = String.raw`([rRfFbBuU]{0,2})("""|` + Q3 + String.raw`|\x60|"|')`;
var STARTS = [
  // NAME = "...", NAME: str = "...", const NAME = `...`
  new RegExp(String.raw`\b((?:[A-Za-z_$][\w$]*)?(?:system|prompt|instruction|persona)[\w$]*)\s*(?::\s*[\w.\[\], |]+?)?\s*=\s*\(?\s*` + OPEN, "gi"),
  // system="...", instructions: "...", {"system": "..."}, systemInstruction: "..."
  new RegExp(String.raw`["']?\b(system|instructions|system_instruction|systemInstruction|system_prompt|systemPrompt)\b["']?\s*[:=]\s*\(?\s*` + OPEN, "g"),
  // {"role": "system", "content": "..."}
  new RegExp(String.raw`["']?role["']?\s*[:=]\s*["'](?:system|developer)["']\s*,\s*["']?(content)["']?\s*[:=]\s*` + OPEN, "g")
];
var NEXT_LITERAL = new RegExp(String.raw`^\s*(\+)?\s*` + OPEN);
var JOINED_WITH_CODE = /^\s*\+\s*[A-Za-z_$(]/;
var USER_SIDE_NAME = /user|human|template|question|query|input|message/i;
var SYSTEM_NAME = /system|instruction|persona/i;
var JSON_SIGNS = /response_format|json_object|json_schema|responseMimeType|response_mime_type|application\/json|json\.loads\(|JSON\.parse\(|with_structured_output|zodResponseFormat/;
function readLiteral(content, start, quote, raw) {
  const multi = quote.length === 3 || quote === "`";
  let i = start;
  let text = "";
  while (i < content.length) {
    const c = content[i];
    if (c === "\\" && !raw) {
      const next = content[i + 1] ?? "";
      const simple = { n: "\n", t: "	", r: "\r", "\\": "\\", "'": "'", '"': '"', "`": "`", "\n": "" };
      if (next in simple) {
        text += simple[next];
        i += 2;
      } else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(content.slice(i + 2, i + 6))) {
        text += String.fromCharCode(parseInt(content.slice(i + 2, i + 6), 16));
        i += 6;
      } else {
        text += c;
        i++;
      }
      continue;
    }
    if (raw && c === "\\" && content[i + 1] === quote[0] && quote.length === 1) {
      text += c + quote;
      i += 2;
      continue;
    }
    if (content.startsWith(quote, i))
      return { text, end: i + quote.length };
    if (c === "\n" && !multi)
      return null;
    text += c;
    i++;
  }
  return null;
}
function readJoined(content, start, prefix, quote, goRaw) {
  const raw = (q, p) => /r/i.test(p) || goRaw && q === "`";
  let lit = readLiteral(content, start, quote, raw(quote, prefix));
  if (!lit)
    return null;
  let text = lit.text;
  for (let guard = 0; guard < 50; guard++) {
    const rest = content.slice(lit.end, lit.end + 2e3);
    const next = NEXT_LITERAL.exec(rest);
    if (!next)
      return { text, partial: JOINED_WITH_CODE.test(rest) };
    const nextLit = readLiteral(content, lit.end + next[0].length, next[3], raw(next[3], next[2]));
    if (!nextLit)
      return { text, partial: false };
    text += nextLit.text;
    lit = nextLit;
  }
  return { text, partial: false };
}
function dedent(text) {
  const lines = text.replace(/^\n/, "").split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(cut)).join("\n").trim();
}
function lineIndex(content) {
  const starts = [0];
  for (let i = 0; i < content.length; i++)
    if (content.charCodeAt(i) === 10)
      starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (starts[mid] <= offset)
        lo = mid;
      else
        hi = mid - 1;
    }
    return lo + 1;
  };
}
function findPromptsInText(file, content) {
  if (!isAiContent(content))
    return [];
  const lineAt = lineIndex(content);
  const goRaw = file.endsWith(".go");
  const found = [];
  const seen = /* @__PURE__ */ new Set();
  for (const re of STARTS) {
    for (const m of content.matchAll(re)) {
      const name = m[1];
      const prefix = m[2];
      const quote = m[3];
      const open = m.index + m[0].length;
      if (seen.has(open))
        continue;
      seen.add(open);
      if (USER_SIDE_NAME.test(name) && !SYSTEM_NAME.test(name))
        continue;
      const joined = readJoined(content, open, prefix, quote, goRaw);
      if (!joined)
        continue;
      const text = dedent(joined.text);
      if (text.length < MIN_CHARS || text.length > MAX_CHARS || !/\s/.test(text))
        continue;
      const templated = /\$\{[^}]+\}|\{[A-Za-z_][\w.]*\}/.test(text);
      if (templated && !/system|instruction|persona|content/i.test(name))
        continue;
      found.push({ file, line: lineAt(m.index), name, text, json: false, templated, partial: joined.partial });
    }
  }
  const fileParsesJson = JSON_SIGNS.test(content);
  for (const p of found)
    p.json = /\bjson\b/i.test(p.text) || fileParsesJson && found.length === 1;
  return found.sort((a, b) => a.line - b.line);
}

// packages/scanner/dist/security.js
var SECURITY_RULES = {
  "ai-key-exposed": {
    title: "AI API key exposed in code or the browser",
    owasp: "LLM02",
    severity: "high",
    why: "Anyone who sees the code or the web page can use the key and run up your bill; stolen AI keys are sold and abused within hours.",
    fix: "Revoke the key now, keep keys in server-side environment variables, and call the AI API from your backend only."
  },
  "model-output-to-sink": {
    title: "Model output passed to eval, a shell, SQL or raw HTML",
    owasp: "LLM05",
    severity: "high",
    why: "Text from the model can be steered by anyone who controls the prompt or the documents it reads, so it can become code, commands or script.",
    fix: "Treat model output as untrusted input: parse it into a fixed structure, use parameterised queries, allow-list commands, and escape HTML."
  },
  "user-input-in-system-prompt": {
    title: "User input placed inside the system prompt",
    owasp: "LLM01",
    severity: "medium",
    why: "Instructions in the system prompt carry the most weight; user text mixed in there can override your rules (prompt injection).",
    fix: "Keep the system prompt fixed and pass user text in a user message, clearly delimited."
  },
  "risky-agent-tool": {
    title: "Agent tool that deletes, pays, sends or runs commands",
    owasp: "ASI02",
    severity: "review",
    why: "An agent tricked by injected instructions can call a high-impact tool on its own.",
    fix: "Ask a person to confirm before the tool acts (or limit what it can touch), and log every call."
  },
  "unpinned-mcp-server": {
    title: "MCP server not pinned to a version",
    owasp: "LLM03",
    severity: "medium",
    why: "npx/uvx fetch the newest release on every start, so a hijacked release runs on your machine with your credentials.",
    fix: "Pin an exact version (package@1.2.3 or package==1.2.3) and update it on purpose."
  }
};
var KEY_PATTERNS = [
  { provider: "Anthropic", re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{60,}/g },
  { provider: "OpenRouter", re: /\bsk-or-v1-[a-f0-9]{48,}/g },
  { provider: "OpenAI", re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}/g },
  { provider: "OpenAI", re: /\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/g },
  { provider: "Google AI", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { provider: "Groq", re: /\bgsk_[A-Za-z0-9]{48,}\b/g },
  { provider: "xAI", re: /\bxai-[A-Za-z0-9]{70,}\b/g }
];
var PLACEHOLDER_RE = /x{6,}|0{8,}|\.\.\.|your|example|placeholder|dummy|fake|redacted|<|>/i;
var PUBLIC_ENV_RE = /\b(?:NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|NUXT_PUBLIC|GATSBY|PUBLIC)_[A-Z0-9_]*(?:OPENAI|ANTHROPIC|CLAUDE|GEMINI|GOOGLE_AI|GENAI|GROQ|MISTRAL|OPENROUTER|XAI|DEEPSEEK|COHERE|PERPLEXITY)[A-Z0-9_]*(?:KEY|TOKEN|SECRET)\b/;
var BROWSER_FLAG_RE = /\bdangerouslyAllowBrowser\s*:\s*true\b/;
function isLocalEnvFile(file) {
  return /^\.env(?:\.[\w-]+)?\.local$/.test(basename3(file).toLowerCase());
}
var isEnvFile = (file) => /^\.env(?:\.[\w-]+)*$/.test(basename3(file).toLowerCase());
function looksReal(key) {
  if (PLACEHOLDER_RE.test(key))
    return false;
  const body = key.replace(/^[a-z]+[-_](?:[a-z]+\d*-)?/i, "");
  return new Set(body).size >= 12 && /\d/.test(body) && /[A-Za-z]/.test(body);
}
var mask = (key) => `${key.slice(0, 4)}\u2026`;
var AI_OUTPUT_RE = /\bchoices\s*\[\s*\d+\s*\]\s*\.(?:message|text)\b|\boutput_text\b|\.content\s*\[\s*\d+\s*\]\s*\.text\b|\b(?:response|result|resp|res|completion|answer|output)\.text\b(?!\s*\()|\.response\.text\s*\(\s*\)/;
var ASSIGN_RE = /^\s*(?:(?:const|let|var|final)\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*[\w[\]|<> ]+)?\s*=(?!=)/;
var SINKS = [
  { name: "eval/exec", re: /(?<![\w.])(?:eval|exec)\s*\(|\bnew\s+Function\s*\(/ },
  { name: "a shell", re: /\bos\.system\s*\(|\bsubprocess\.(?:run|call|Popen|check_output|check_call)\s*\(|\b(?:execSync|spawnSync|execFileSync)\s*\(/ },
  { name: "SQL", re: /\b(?:cursor|conn|connection|db|session)\.(?:execute|executemany|exec_driver_sql)\s*\(|\.(?:\$queryRawUnsafe|\$executeRawUnsafe)\s*\(/ },
  { name: "raw HTML", re: /\bdangerouslySetInnerHTML\b|\.(?:innerHTML|outerHTML)\s*=|\bdocument\.write\s*\(|\bv-html\b|\bmark_safe\s*\(|\bMarkup\s*\(/ }
];
var PARSED_RE = /\b(?:json\.loads|JSON\.parse|model_validate(?:_json)?|parse_obj|safeParse|\.parse)\s*\(/;
function firstArgument(line, from) {
  let depth = 0;
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if ("([{".includes(c))
      depth++;
    else if (")]}".includes(c)) {
      if (depth === 0)
        return line.slice(from, i);
      depth--;
    } else if (c === "," && depth === 0)
      return line.slice(from, i);
  }
  return line.slice(from);
}
var usesVar = (line, name) => new RegExp(`(?<![\\w.$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(line);
var USER_INPUT_NAME_RE = /^(?:user|input|query|question|message|msg|request|req|body|params|comment|feedback|search|q|text)(?:[._[\]'"]|$)|user_?input|user_?message|user_?query|user_?question|req\.(?:body|query|params)/i;
var TOOL_CONTEXT_RE = /\btools\s*[=:[]|function_declarations|functionDeclarations|input_schema|\bparameters\s*["']?\s*:|@(?:\w+\.)?tool\b|\btool\s*\(|\bFunctionTool\b|\bStructuredTool\b|@function_tool\b/;
var CONFIRMATION_RE = /confirm|approv|human_in_the_loop|humanInTheLoop|\binterrupt|needsApproval|requires?_approval|ask_user|askUser/i;
var TEST_FILE_RE = /(?:^|\/)(?:tests?|__tests__|spec|e2e|fixtures?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go)$/i;
var RISKY_VERB_RE = /^(?:delete|remove|drop|destroy|purge|wipe|truncate|pay|charge|refund|transfer|withdraw|send|email|purchase|buy|cancel|run_shell|run_command|execute_command|exec|execute_sql|shell)(?:_|$)/;
var TOOL_NAME_RES = [
  /["']?name["']?\s*:\s*["']([A-Za-z][\w-]{2,60})["']/g,
  /@(?:\w+\.)?(?:tool|function_tool)(?:\([^)]*\))?\s*\n\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*tool\s*\(/g,
  /^\s*([A-Za-z_$][\w$]*)\s*:\s*tool\s*\(/gm,
  /\b(?:Tool|StructuredTool(?:\.from_function)?|FunctionTool(?:\.from_defaults)?)\s*\([^)]{0,400}?\bname\s*=\s*["']([A-Za-z][\w-]{2,60})["']/g
];
var snake = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
var MCP_FILE_RE = /(?:^|\/)(?:\.?mcp|mcp_settings|claude_desktop_config|cline_mcp_settings)\.json$/i;
var RUNNERS = /* @__PURE__ */ new Set(["npx", "bunx", "uvx", "pnpx"]);
var FLAGS_WITH_VALUE = /* @__PURE__ */ new Set(["--python", "-p", "--with", "--package", "--index-url", "--registry", "--cache", "-c", "--call"]);
function packageSpec(rawCommand, rawArgs) {
  const [first = "", ...inline] = rawCommand.trim().split(/\s+/);
  const command = basename3(first.replace(/\\/g, "/")).replace(/\.(?:cmd|exe|ps1)$/i, "").toLowerCase();
  let rest = [...inline, ...rawArgs];
  if (command === "pnpm" && rest[0] === "dlx")
    rest = rest.slice(1);
  else if (!RUNNERS.has(command))
    return null;
  let spec;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--from") {
      spec = rest[i + 1];
      break;
    }
    if (FLAGS_WITH_VALUE.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-"))
      continue;
    spec = a;
    break;
  }
  if (!spec)
    return null;
  const version = /^@?[^@\s]+@(.+)$/.exec(spec)?.[1] ?? /==([^,\s]+)$/.exec(spec)?.[1];
  return { spec, pinned: Boolean(version && /^\d+\.\d+\.\d+[\w.+-]*$/.test(version)) };
}
function lineOf2(lines, needle) {
  const i = lines.findIndex((l) => l.includes(needle));
  return i >= 0 ? i + 1 : 1;
}
function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = i;
      const m = end.exec(text);
      if (!m)
        return void 0;
      out += m[0];
      i += m[0].length - 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n")
        i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1)
        return void 0;
      i = close + 1;
    } else
      out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return void 0;
  }
}
function mcpFindings(file, content, lines) {
  const config = parseJsonc(content);
  if (config === void 0)
    return [];
  const root = config ?? {};
  const servers = root.mcpServers ?? root.servers ?? root.mcp?.servers;
  if (!servers || typeof servers !== "object")
    return [];
  const out = [];
  for (const [name, raw] of Object.entries(servers)) {
    const s = raw;
    if (typeof s?.command !== "string")
      continue;
    const args = Array.isArray(s.args) ? s.args.filter((a) => typeof a === "string") : [];
    const parsed = packageSpec(basename3(s.command), args);
    if (!parsed || parsed.pinned)
      continue;
    out.push({ file, line: lineOf2(lines, parsed.spec), rule: "unpinned-mcp-server", detail: `${name}: ${parsed.spec}` });
  }
  return out;
}
var COMMENT_LINE_RE2 = /^\s*(?:#|\/\/|\/\*|\*|--)/;
function findSecurityIssues(file, content, kind) {
  const lines = content.split(/\r?\n/);
  const out = [];
  const add = (index, rule, detail) => out.push({ file, line: index + 1, rule, detail });
  const localEnv = isLocalEnvFile(file);
  lines.forEach((line, i) => {
    if (!localEnv) {
      for (const { provider, re } of KEY_PATTERNS) {
        for (const m of line.matchAll(re)) {
          if (!looksReal(m[0]))
            continue;
          add(i, "ai-key-exposed", isEnvFile(file) ? `${provider} key ${mask(m[0])} in ${basename3(file)}: exposed if this file is committed (keep it git-ignored)` : `${provider} key ${mask(m[0])} written in the file`);
        }
      }
    }
    const pub = PUBLIC_ENV_RE.exec(line);
    if (pub)
      add(i, "ai-key-exposed", `${pub[0]} is sent to the browser by the build`);
    if (BROWSER_FLAG_RE.test(line))
      add(i, "ai-key-exposed", "dangerouslyAllowBrowser: true puts the API key in the browser");
  });
  const vscodeSettings = /(?:^|\/)settings\.json$/i.test(file) && content.includes('"mcp"') && content.includes('"servers"');
  if (kind === "config" && (MCP_FILE_RE.test(file) || content.includes('"mcpServers"') || vscodeSettings))
    out.push(...mcpFindings(file, content, lines));
  if (kind !== "code" || TEST_FILE_RE.test(file) || !isAiContent(content))
    return out.sort((a, b) => a.line - b.line);
  const fromModel = /* @__PURE__ */ new Set();
  lines.forEach((line, i) => {
    if (COMMENT_LINE_RE2.test(line))
      return;
    const assigned = ASSIGN_RE.exec(line)?.[1];
    const direct = AI_OUTPUT_RE.test(line);
    const rhs = line.slice(line.indexOf("=") + 1);
    if (assigned && !PARSED_RE.test(rhs) && (direct || [...fromModel].some((v) => usesVar(rhs, v))))
      fromModel.add(assigned);
    for (const sink of SINKS) {
      const hit = sink.re.exec(line);
      if (!hit)
        continue;
      const scope = sink.name === "SQL" ? firstArgument(line, hit.index + hit[0].length) : line;
      if (sink.name === "SQL" && !AI_OUTPUT_RE.test(scope) && ![...fromModel].some((v) => usesVar(scope, v)))
        continue;
      const via = AI_OUTPUT_RE.test(scope) ? null : [...fromModel].find((v) => usesVar(scope, v));
      if (AI_OUTPUT_RE.test(scope) || via) {
        add(i, "model-output-to-sink", `${via ? `\`${via}\` (from the model's answer)` : "the model's answer"} goes to ${sink.name}`);
        break;
      }
    }
  });
  for (const p of findPromptsInText(file, content)) {
    if (!p.templated)
      continue;
    const placeholders = [...p.text.matchAll(/\$\{([^}]+)\}|\{([A-Za-z_][\w.[\]'"]*)\}/g)].map((m) => (m[1] ?? m[2] ?? "").trim());
    const user = placeholders.find((name) => USER_INPUT_NAME_RE.test(name));
    if (user)
      add(p.line - 1, "user-input-in-system-prompt", `{${user}} inside ${p.name}`);
  }
  if (TOOL_CONTEXT_RE.test(content)) {
    const risky = /* @__PURE__ */ new Map();
    for (const re of TOOL_NAME_RES) {
      for (const m of content.matchAll(re)) {
        const name = m[1];
        if (risky.has(name) || !RISKY_VERB_RE.test(snake(name)))
          continue;
        risky.set(name, content.slice(0, m.index + m[0].indexOf(name)).split("\n").length - 1);
      }
    }
    if (risky.size > 0) {
      let code3 = content.replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
      for (const name of risky.keys())
        code3 = code3.split(name).join("");
      if (!CONFIRMATION_RE.test(code3))
        for (const [name, index] of risky)
          add(index, "risky-agent-tool", `tool ${name}`);
    }
  }
  return out.sort((a, b) => a.line - b.line);
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
var AI_OUTPUT_RE2 = /\bchoices\s*\[|\boutput_text\b|\bmessage\.content\b|\.content\s*\[\s*\d+\s*\]\s*\.text\b|\bresponse\.text\b|\bcompletion\.text\b/;
var EMPTY_ARGS_RE = /^\(\s*\)/;
var TRIPLE_QUOTE_RE = /"""|'''/g;
var STRUCTURED_RE = /\b(?:response_format|json_schema|responseMimeType|response_mime_type|responseSchema|response_schema|generateObject|zodResponseFormat|text_format|output_format|tool_choice)\b/;
var COMMENT_LINE_RE3 = /^\s*(?:#|\/\/|\/\*|\*|--)/;
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
    if (wasInDocstring || quoteCount > 0 || COMMENT_LINE_RE3.test(line))
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
    if (!usesStructuredOutput && !jsonTipGiven && JSON_PARSE_RE.test(line) && AI_OUTPUT_RE2.test(line)) {
      tip("json-without-structured-output");
      jsonTipGiven = true;
    }
  });
  return tips;
}

// packages/scanner/dist/scan.js
var MAX_FILE_BYTES = 1e6;
var MAX_LOCKFILE_BYTES = 3e7;
async function scanDirectory(root) {
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory())
    throw new Error(`Not a folder: ${root}`);
  const rules = compileApiRules(apis);
  const result = { root, filesScanned: 0, aiFiles: 0, callSites: 0, findings: [], tokenTips: [], security: [], dependencies: [] };
  const ownPackages = /* @__PURE__ */ new Set();
  for await (const file of walk(root)) {
    const size = (await stat(file.path)).size;
    if (size > (file.lock ? MAX_LOCKFILE_BYTES : MAX_FILE_BYTES))
      continue;
    const content = await readFile2(file.path, "utf8");
    if (content.includes("\0"))
      continue;
    const own = ownPackageName(file.rel, content);
    if (own)
      ownPackages.add(own);
    if (isDependencyFile(file.rel)) {
      for (const { needle, ...dep } of parseDependencies(file.rel, content)) {
        if (isAiRelated(dep.ecosystem, dep.name))
          result.dependencies.push({ ...dep, line: lineOf(content, needle) });
      }
    }
    if (file.lock)
      continue;
    const scanned = scanText(file.rel, content, file.kind, rules);
    result.filesScanned++;
    if (scanned.isAiFile && file.kind === "code")
      result.aiFiles++;
    result.callSites += scanned.callSites;
    result.findings.push(...scanned.findings);
    if (scanned.isAiFile)
      result.tokenTips.push(...findTokenTips(file.rel, content, file.kind));
    result.security.push(...findSecurityIssues(file.rel, content, file.kind));
  }
  result.dependencies = result.dependencies.filter((d) => !(d.ecosystem === "npm" && ownPackages.has(d.name)));
  const npmrc = await readFile2(join2(root, ".npmrc"), "utf8").catch(() => "");
  const registries = privateRegistries(npmrc);
  for (const d of result.dependencies) {
    if (d.ecosystem === "npm" && (registries.all || registries.scopes.some((s) => d.name.startsWith(`${s}/`))))
      d.privateIndex = true;
  }
  return result;
}

// packages/scanner/dist/costs.js
var RECENT_DAYS = 30;
function dayBefore(date) {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
}
function changeRow(m, change2, priced, today) {
  const before = priceOn(priced, m.platform, dayBefore(change2.on));
  if (!before)
    return void 0;
  const row = {
    id: m.id,
    platform: m.platform,
    kind: change2.kind,
    on: change2.on,
    daysLeft: daysBetween(today, change2.on),
    before,
    verified: change2.verified,
    locations: m.locations
  };
  if (priced !== m.id)
    row.billedAs = priced;
  if (change2.input !== void 0 && change2.output !== void 0)
    row.after = { input: change2.input, output: change2.output };
  if (change2.note)
    row.note = change2.note;
  return row;
}
function buildCostRows(models2, today) {
  const rows = [];
  const keep = (on) => daysBetween(today, on) >= -RECENT_DAYS;
  const push = (row) => row && rows.push(row);
  for (const m of models2) {
    const ownUntil = m.reroute?.on;
    for (const change2 of lookupPriceChanges(m.id, m.platform)) {
      if (keep(change2.on) && (!ownUntil || change2.on < ownUntil))
        push(changeRow(m, change2, m.id, today));
    }
    const target = m.reroute ? lookupPrice(m.reroute.to, m.platform) : void 0;
    if (!m.reroute || !target)
      continue;
    const { on, to } = m.reroute;
    const before = priceOn(m.id, m.platform, dayBefore(on));
    const after = priceOn(to, m.platform, on);
    if (keep(on) && before && after && (before.input !== after.input || before.output !== after.output)) {
      rows.push({
        id: m.id,
        platform: m.platform,
        kind: "reroute-billing",
        on,
        daysLeft: daysBetween(today, on),
        before,
        after,
        billedAs: to,
        verified: target.verified,
        note: `Requests are answered by ${to} and billed at its rates.`,
        locations: m.locations
      });
    }
    for (const change2 of lookupPriceChanges(to, m.platform)) {
      if (change2.on > on && keep(change2.on))
        push(changeRow(m, change2, to, today));
    }
  }
  return rows.sort((a, b) => a.on.localeCompare(b.on) || a.id.localeCompare(b.id));
}
function formatPrice(price) {
  return `${formatUsd(price.input)} input, ${formatUsd(price.output)} output per 1M tokens`;
}
function formatPriceMove(before, after) {
  return `${formatUsd(before.input)} \u2192 ${formatUsd(after.input)} input, ${formatUsd(before.output)} \u2192 ${formatUsd(after.output)} output per 1M tokens`;
}
function percent(from, to) {
  return from === 0 ? 0 : Math.round((to - from) / from * 100);
}
function priceChangeText(before, after) {
  const i = percent(before.input, after.input);
  const o = percent(before.output, after.output);
  const sign = (n) => n > 0 ? `+${n}%` : `${n}%`;
  return i === o ? sign(i) : `input ${sign(i)}, output ${sign(o)}`;
}
function isPriceRise(row) {
  if (!row.after)
    return true;
  const up = row.after.input > row.before.input || row.after.output > row.before.output;
  const down = row.after.input < row.before.input || row.after.output < row.before.output;
  return up && !down;
}
function describeCost(row) {
  const subject = row.billedAs && row.kind !== "reroute-billing" ? `${row.id} (served as ${row.billedAs})` : row.id;
  const when = row.daysLeft > 0 ? `on ${row.on} (in ${row.daysLeft} day${row.daysLeft === 1 ? "" : "s"})` : `since ${row.on}`;
  if (row.kind === "reroute-billing" && row.after) {
    return `${subject} is billed as ${row.billedAs} ${when}: ${formatPriceMove(row.before, row.after)} (${priceChangeText(row.before, row.after)})`;
  }
  if (!row.after) {
    const what = row.kind === "intro-ends" ? `introductory price ${row.daysLeft > 0 ? "ends" : "ended"}` : `price ${row.daysLeft > 0 ? "changes" : "changed"}`;
    return `${subject}: ${what} ${when}; the new price is not published yet (${row.daysLeft > 0 ? "now" : "was"} ${formatPrice(row.before)})`;
  }
  return `${subject}: price ${isPriceRise(row) ? "rises" : "changes"} ${when}: ${formatPriceMove(row.before, row.after)} (${priceChangeText(row.before, row.after)})`;
}

// packages/scanner/dist/report.js
var SEVERITY_ORDER = { high: 0, medium: 1, review: 2 };
var STATUS_ORDER = {
  retired: 0,
  rerouted: 1,
  retiring: 2,
  rerouting: 3,
  "no-known-retirement": 4
};
function statusFor(entry, today) {
  if (!entry)
    return { status: "no-known-retirement" };
  const daysLeft = daysBetween(today, entry.retiresOn);
  const past = daysLeft <= 0;
  const status = entry.reroutesTo ? past ? "rerouted" : "rerouting" : past ? "retired" : "retiring";
  return { status, daysLeft, date: entry.retiresOn };
}
function costRowsFor(models2, today) {
  return buildCostRows(models2.map((m) => ({
    id: m.id,
    platform: m.platform,
    locations: m.locations,
    ...m.reroutesTo && m.date ? { reroute: { on: m.date, to: m.reroutesTo } } : {}
  })), today);
}
function addPrices(row, today) {
  const price = billedPriceOn(row.id, row.platform, today);
  if (price)
    row.price = price;
  const replacementPrice = row.replacement ? billedPriceOn(row.replacement, row.platform, today) : void 0;
  if (row.replacement && replacementPrice) {
    row.replacementPrice = replacementPrice;
    const ratio = tokenRatio({ id: row.id, platform: row.platform }, { id: row.replacement, platform: row.platform });
    if (ratio !== 1)
      row.replacementTokenRatio = ratio;
  }
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
        addPrices(row, today);
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
  const securityRows = /* @__PURE__ */ new Map();
  for (const f of result.security ?? []) {
    let row = securityRows.get(f.rule);
    if (!row) {
      row = { rule: f.rule, ...SECURITY_RULES[f.rule], findings: [] };
      securityRows.set(f.rule, row);
    }
    row.findings.push({ location: `${f.file}:${f.line}`, detail: f.detail });
  }
  const security = [...securityRows.values()].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.findings.length - a.findings.length);
  const costs = costRowsFor(models2, today);
  const aiPackages = aiPackagesOf(result.dependencies ?? []);
  return {
    target,
    today,
    filesScanned: result.filesScanned,
    aiFiles: result.aiFiles,
    callSites: result.callSites,
    models: models2,
    dynamic,
    apis: apiRows,
    tokenTips,
    security,
    costs,
    aiPackages,
    packages: sortPackageRows(checkPackagesOffline(aiPackages))
  };
}
async function addOnlinePackageChecks(report, options) {
  const { rows, failed } = await checkPackagesOnline(report.aiPackages ?? [], options);
  const offline = (report.packages ?? []).filter((p) => p.source === "catalog");
  return { ...report, packages: sortPackageRows([...offline, ...rows]), packagesOnline: { checked: true, failed } };
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
  const keyRow = report.security?.find((s) => s.rule === "ai-key-exposed");
  const introducedKey = Boolean(keyRow && inChangedFiles(keyRow.findings.map((f) => f.location), changed));
  const compromised = (report.packages ?? []).filter((p) => p.issue === "compromised");
  const introducedPackage = compromised.some((p) => inChangedFiles(p.locations, changed));
  const conclusion = introducedDead || introducedKey || introducedPackage ? "failure" : compromised.length > 0 ? "neutral" : dead.length + deadApis.length + soon.length + soonApis.length > 0 ? "neutral" : "success";
  const parts = [];
  if (dead.length + deadApis.length > 0)
    parts.push(`${dead.length + deadApis.length} retired`);
  if (soon.length + soonApis.length > 0)
    parts.push(`${soon.length + soonApis.length} changing within ${SOON_DAYS} days`);
  const modelTitle = parts.length > 0 ? `AI models and APIs: ${parts.join(", ")}` : `${report.models.length} AI models found, none changing soon`;
  const title = introducedKey ? `AI API key exposed in this pull request \xB7 ${modelTitle}` : compromised.length > 0 ? `Malicious AI package release installed \xB7 ${modelTitle}` : modelTitle;
  const lines = [];
  if (introducedKey)
    lines.push("**This pull request adds or touches a file with an exposed AI API key. Revoke the key and move it to a server-side secret.**", "");
  if (introducedDead)
    lines.push("**This pull request touches code that uses a retired AI model or API.**", "");
  if (compromised.length > 0) {
    lines.push(`**${introducedPackage ? "This pull request installs" : "This repository installs"} an AI package release that was published with malicious code.** ${PACKAGE_FIX.compromised}`);
    for (const p of compromised)
      lines.push(`- ${describePackage(p)} (${p.locations.slice(0, 3).map((l) => `\`${l}\``).join(", ")})${p.url ? ` [advisory](${p.url})` : ""}`);
    lines.push("");
  }
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
  const costs = (report.costs ?? []).filter((c) => c.daysLeft <= SOON_DAYS);
  if (costs.length > 0) {
    lines.push("", "**Price changes** (advisory):");
    for (const c of costs)
      lines.push(`- ${describeCost(c)}`);
  }
  if (report.security?.length) {
    lines.push("", "**AI security check** (advisory):");
    for (const s of report.security) {
      const where = s.findings.slice(0, 3).map((f) => `\`${f.location}\``).join(", ") + (s.findings.length > 3 ? ` +${s.findings.length - 3} more` : "");
      lines.push(`- ${s.severity === "high" ? "**High:** " : ""}${s.title} [${s.owasp}]: ${where}. ${s.fix}`);
    }
  }
  const otherPackages = (report.packages ?? []).filter((p) => p.issue !== "compromised");
  if (otherPackages.length > 0) {
    lines.push("", "**AI packages to review** (advisory):");
    for (const p of otherPackages)
      lines.push(`- ${describePackage(p)}`);
  }
  if (report.tokenTips.length > 0) {
    lines.push("", "**Token Saver:** " + report.tokenTips.map((t) => `${t.title} (${t.locations.length})`).join(" \xB7 "));
  }
  lines.push("", `Scanned ${report.filesScanned} files \xB7 ${report.models.length} models \xB7 ${report.callSites} AI call sites.`);
  return { conclusion, title, summary: lines.join("\n") };
}

// packages/scanner/dist/switch.js
import { readFile as readFile3, writeFile } from "node:fs/promises";
import { join as join3 } from "node:path";
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
    const lines = (await readFile3(join3(root, file), "utf8")).split("\n");
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
import { createHash as createHash2 } from "node:crypto";
import { readFile as readFile4 } from "node:fs/promises";
import { join as join4, posix } from "node:path";
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
function evidenceBody(plan, replay, scanPath, note, extra) {
  const where = (file, line) => `\`${posix.join(scanPath || ".", file)}:${line}\``;
  const t = replay.totals;
  const prompts = replay.items.length;
  const lines = [
    ...note ? [`> ${note}`, ""] : [],
    `## Switch \`${plan.from}\` to \`${plan.to}\``,
    "",
    ...extra ? [extra, ""] : [],
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
  return createHash2("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
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
    const reason = !entry ? "Not committed in the repository (untracked or gitignored), so it is left out of the PR." : gitBlobSha(await readFile4(join4(input2.workspace, path))) !== entry.sha ? "Changed by an earlier step of this job, so it is left out of the PR." : null;
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
  const body = evidenceBody(plan, replay, input2.scanPath, void 0, input2.extra);
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
    await api("PATCH", `/repos/${repo}/pulls/${pr.number}`, { body: owned ? body : evidenceBody(plan, replay, input2.scanPath, note, input2.extra) });
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
  if (report.packages?.some((p) => p.issue === "compromised")) return true;
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
  let report = buildReport(scan, env.GITHUB_REPOSITORY ?? workspace, today);
  if (oneOf(input("online-package-check", env) || "false", "online-package-check", ["true", "false"]) === "true") {
    report = await addOnlinePackageChecks(report, { today });
  }
  const check = buildCheck(report, null);
  await summary(`## AI Change Guard: ${check.title}

${check.summary}`);
  let failed = scanFails(report, failOn);
  log(failed ? `::error::AI Change Guard: ${check.title}` : `AI Change Guard: ${check.title}`);
  const prompts = input("prompts", env);
  const oldModel = input("old-model", env);
  const newModel = input("new-model", env);
  const baselinePath = input("baseline", env);
  if (baselinePath) {
    if (!prompts) throw new Error('A watch needs "prompts" (the golden set the baseline was made from).');
    if (oldModel || newModel || openPr) throw new Error('"baseline" runs a watch of one model; leave out old-model, new-model and open-pr.');
    const baseline = parseBaseline(await readFile5(resolve(workspace, baselinePath), "utf8"));
    const items = await loadGoldenSet(resolve(workspace, prompts));
    const runsInput = input("runs", env);
    const watch = await runWatch({
      items,
      baseline,
      client: client ?? withRetry(createClient({ env })),
      concurrency: positive(input("concurrency", env) || "2", "concurrency"),
      maxCalls: positive(input("max-calls", env) || "300", "max-calls"),
      ...runsInput ? { runs: positive(runsInput, "runs") } : {}
    });
    await summary(formatWatchMarkdown(watch));
    const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : void 0;
    const webhook = input("slack-webhook", env);
    if (watch.alert && webhook) {
      await postSlack(webhook, slackMessage(watch, runUrl)).then(
        () => log("AI Change Guard watch: alert posted to Slack"),
        (error) => log(`::warning::AI Change Guard watch: could not post to Slack: ${error instanceof Error ? error.message : String(error)}`)
      );
    }
    const t = watch.report.totals;
    log(`${watch.alert ? "::error::" : ""}AI Change Guard watch: ${t.same} same, ${t.changed} changed, ${t.broken} broken${watch.reroutes.length ? `, rerouted to ${watch.reroutes.map((r) => r.served).join(", ")}` : ""}`);
    return failed || watch.alert ? 1 : 0;
  }
  if (oneOf(input("find-savings", env) || "false", "find-savings", ["true", "false"]) === "true") {
    if (!prompts || !oldModel) throw new Error('find-savings needs "prompts" and "old-model" (the model you use now).');
    if (newModel) throw new Error('find-savings picks the new model itself: remove "new-model", or run the replay in a separate step.');
    const candidatesInput = input("candidates", env);
    const candidates3 = candidatesInput ? cleanCandidates(oldModel, candidatesInput.split(",")) : cheaperCandidates(oldModel, today).map((c) => c.ref);
    if (candidatesInput && candidates3.length === 0) throw new Error('"candidates" needs at least one model other than "old-model".');
    const plans = /* @__PURE__ */ new Map();
    if (openPr) {
      for (const c of candidates3) {
        if (candidateProblem(c, today)) continue;
        const ids = switchIds(oldModel, c);
        plans.set(c, await planSwitch(scanRoot, scan.findings, ids.from, ids.to, ids.prefix ? { prefix: ids.prefix } : {}));
      }
    }
    const callsInput = input("calls-per-month", env);
    const llm = client ?? withRetry(createClient({ env }));
    const result = await findSavings({
      candidates: candidates3,
      items: await loadGoldenSet(resolve(workspace, prompts)),
      primary: oldModel,
      client: llm,
      runs: positive(input("runs", env) || "3", "runs"),
      concurrency: positive(input("concurrency", env) || "2", "concurrency"),
      maxCalls: positive(input("max-calls", env) || "300", "max-calls"),
      today,
      ...callsInput ? { callsPerMonth: positive(callsInput, "calls-per-month") } : {}
    });
    const card = formatSavingsMarkdown(result);
    await summary(card);
    log(result.best ? `AI Change Guard Money-Finder: ${result.best.model} passes and is ${Math.round((result.best.savingShare ?? 0) * 100)}% cheaper per call` : "AI Change Guard Money-Finder: no cheaper model passed");
    if (openPr && result.best) {
      const plan = plans.get(result.best.model);
      const notice = (text) => log(`::notice::AI Change Guard: ${text}`);
      if (result.skippedPrompts.length > 0) notice(`no pull request, because ${oldModel} did not answer ${result.skippedPrompts.length} prompt(s), so the comparison is incomplete.`);
      else if (plan.edits.length === 0) notice(`no pull request, because no code uses ${plan.from} as a plain model ID.`);
      else {
        const token = input("github-token", env) || env.GITHUB_TOKEN || "";
        if (!github && !token) throw new Error('open-pr needs a token: keep the default "github-token" input or pass one.');
        const pr = await openEvidencePr({
          api: github ?? githubApi(token, env.GITHUB_API_URL),
          repo: env.GITHUB_REPOSITORY ?? "",
          ref: env.GITHUB_REF ?? "",
          sha: env.GITHUB_SHA ?? "",
          workspace,
          scanPath: relative2(workspace, scanRoot).split(sep2).join("/"),
          plan,
          replay: result.best.report,
          extra: card.replace(/^## .*\n\n/, "")
        });
        if (pr.action === "skipped") notice(`no pull request. ${pr.reason}`);
        else {
          log(`AI Change Guard ${pr.action} pull request #${pr.number}: ${pr.url}`);
          await summary(`**Savings pull request ${pr.action}:** [#${pr.number}](${pr.url})`);
        }
      }
    }
    return failed ? 1 : 0;
  }
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
