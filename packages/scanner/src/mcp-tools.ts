// MCP Tool Change Guard: lists the tools each MCP server in the project's config offers, so ai-stack.lock can
// record them and flag a tool that appears, disappears or changes its description or inputs. A changed tool
// description is how hidden instructions reach an AI agent ("tool poisoning"), so descriptions are kept as
// text: the pull request diff of ai-stack.lock shows exactly what changed.
//
// Listing tools means STARTING the servers (running their commands, or calling their URLs). Only the CLI and
// the GitHub Action do this, on the user's own machine or runner, when asked (--mcp / mcp-tools: true).
// A hosted service must never call this on a repository it does not own.
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export interface McpServerConfig {
  name: string;
  /** The config file it comes from. */
  file: string;
  /** stdio servers. */
  command?: string;
  args: string[];
  /** Environment for the server; values may hold secrets, so they are never written to a report or the lock. */
  env?: Record<string, string>;
  /** HTTP servers. */
  url?: string;
  headers?: Record<string, string>;
  /** "sse" for servers that speak the older SSE transport (from the config's "type"). */
  transport?: "sse" | "http";
}

export interface McpToolPrint {
  name: string;
  /** The description as the server reports it, shortened to 4,000 characters for reading in a diff. */
  description: string;
  /** Fingerprint of the FULL description: a change past the shortened text is still caught. */
  descriptionHash: string;
  /** Fingerprint of the tool's input schema. */
  inputs: string;
}

export interface McpServerTools {
  name: string;
  file: string;
  tools?: McpToolPrint[];
  /** Why the tools could not be listed. */
  error?: string;
}

const MAX_DESCRIPTION = 4000;

/** JSON with object keys sorted at every level, so the same schema always gives the same fingerprint. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex").slice(0, 16);
}

/** The lock's record of a server's tools, sorted by name. */
export function toolPrints(tools: { name: string; description?: string; inputSchema?: unknown }[]): McpToolPrint[] {
  return tools
    .map((t) => ({
      name: t.name,
      description: (t.description ?? "").slice(0, MAX_DESCRIPTION),
      descriptionHash: fingerprint(t.description ?? ""),
      inputs: fingerprint(t.inputSchema ?? {}),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Replaces ${VAR} and ${env:VAR} with values from `env` (unknown names become empty). */
export function expandVars(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? "");
}

const SECRET_ARG = /^(sk-|gh[psu]_|AIza|xox[abp]-|re_|npg_|rzp_)|[A-Za-z0-9_-]{32,}/;
const SECRET_FLAG = /(key|token|secret|password|auth)/i;

/**
 * How a server will be started or reached, for a log the user (or a public CI log) reads before anything
 * runs. Env and header values are never shown; key-like arguments, the value after a --key/--token style
 * flag, and URL query strings are replaced with "***".
 */
export function describeServer(server: McpServerConfig): string {
  if (server.url) return `${server.name}: ${server.url.replace(/\?.*$/, (q) => (q ? "?***" : ""))}`;
  const args = server.args.map((a, i) => {
    const prev = server.args[i - 1] ?? "";
    if (SECRET_ARG.test(a) || (prev.startsWith("-") && SECRET_FLAG.test(prev))) return "***";
    return a.replace(/^(--?[\w-]*(?:key|token|secret|password|auth)[\w-]*=).+$/i, "$1***");
  });
  return `${server.name}: ${[server.command, ...args].join(" ")}`;
}

export interface ListOptions {
  /** The project folder: each stdio server runs in the folder of the config file that declares it. */
  cwd: string;
  /** Per server. Default 30 s (npx may download the server first). */
  timeoutMs?: number;
  /**
   * Values for ${VAR} in the config. On a shared runner pass only the variables the user allowed: a config
   * changed in a pull request could otherwise send any runner variable to any URL.
   */
  env?: Record<string, string | undefined>;
}

/** Most pages a tools/list may take, so a server that keeps answering with a cursor can't loop forever. */
const MAX_PAGES = 100;

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Starts (or connects to) one server, lists every tool (all pages), and closes it. Never throws. */
export async function listServerTools(server: McpServerConfig, options: ListOptions): Promise<McpServerTools> {
  try {
    return await listOne(server, options);
  } catch (error) {
    return { name: server.name, file: server.file, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
}

async function listOne(server: McpServerConfig, options: ListOptions): Promise<McpServerTools> {
  const base = { name: server.name, file: server.file };
  const env = options.env ?? process.env;
  // Loaded only here, so code that never lists tools (such as a hosted scan) never loads the MCP client.
  const sdk = await import("@modelcontextprotocol/client");
  const timeout = options.timeoutMs ?? 30_000;
  if (server.url) {
    const url = new URL(expandVars(server.url, env));
    const headers = Object.fromEntries(Object.entries(server.headers ?? {}).map(([k, v]) => [k, expandVars(v, env)]));
    const sse = () => new sdk.SSEClientTransport(url, { requestInit: { headers } });
    const http = () => new sdk.StreamableHTTPClientTransport(url, { requestInit: { headers } });
    // Streamable HTTP first (the current transport); an older SSE-only server gets a second try over SSE.
    if (server.transport === "sse" || url.pathname.endsWith("/sse")) return listOver(sse(), server, timeout);
    const first = await listOver(http(), server, timeout);
    return first.tools ? first : listOver(sse(), server, timeout).then((second) => (second.tools ? second : first));
  }
  if (!server.command) return { ...base, error: "no command or url in the config" };
  const { StdioClientTransport, getDefaultEnvironment } = await import("@modelcontextprotocol/client/stdio");
  const serverEnv = Object.fromEntries(Object.entries(server.env ?? {}).map(([k, v]) => [k, expandVars(v, env)]));
  const transport = new StdioClientTransport({
    command: expandVars(server.command, env),
    args: server.args.map((a) => expandVars(a, env)),
    env: { ...getDefaultEnvironment(), ...serverEnv },
    // Relative paths in a config (./server.js) are relative to that config file.
    cwd: join(options.cwd, dirname(server.file)),
    stderr: "ignore",
  });
  return listOver(transport, server, timeout);
}

type AnyTransport = Parameters<InstanceType<typeof import("@modelcontextprotocol/client").Client>["connect"]>[0];

async function listOver(transport: AnyTransport, server: McpServerConfig, timeout: number): Promise<McpServerTools> {
  const base = { name: server.name, file: server.file };
  const { Client } = await import("@modelcontextprotocol/client");
  const client = new Client({ name: "ai-change-guard", version: "1" });
  try {
    await withTimeout(client.connect(transport), timeout, server.name);
    const tools: { name: string; description?: string; inputSchema?: unknown }[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await withTimeout(client.listTools(cursor ? { cursor } : {}), timeout, server.name);
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    return { ...base, tools: toolPrints(tools) };
  } catch (error) {
    return { ...base, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Lists the tools of every server, one at a time (servers may share ports or files). */
export async function listMcpTools(servers: McpServerConfig[], options: ListOptions): Promise<McpServerTools[]> {
  const out: McpServerTools[] = [];
  for (const server of servers) out.push(await listServerTools(server, options));
  return out.sort((a, b) => (`${a.file}|${a.name}` < `${b.file}|${b.name}` ? -1 : 1));
}
