// MCP Tool Change Guard: lists the tools each MCP server in the project's config offers, so ai-stack.lock can
// record them and flag a tool that appears, disappears or changes its description or inputs. A changed tool
// description is how hidden instructions reach an AI agent ("tool poisoning"), so descriptions are kept as
// text: the pull request diff of ai-stack.lock shows exactly what changed.
//
// Listing tools means STARTING the servers (running their commands, or calling their URLs). Only the CLI and
// the GitHub Action do this, on the user's own machine or runner, when asked (--mcp / mcp-tools: true).
// A hosted service must never call this on a repository it does not own.
import { createHash } from "node:crypto";

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
}

export interface McpToolPrint {
  name: string;
  /** The description as the server reports it (at most 4,000 characters). */
  description: string;
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
    .map((t) => ({ name: t.name, description: (t.description ?? "").slice(0, MAX_DESCRIPTION), inputs: fingerprint(t.inputSchema ?? {}) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Replaces ${VAR} and ${env:VAR} with values from `env` (unknown names become empty). */
export function expandVars(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? "");
}

/** How a server will be started or reached, for the user to see before anything runs. Never includes env or header values. */
export function describeServer(server: McpServerConfig): string {
  return server.url ? `${server.name}: ${server.url}` : `${server.name}: ${[server.command, ...server.args].join(" ")}`;
}

export interface ListOptions {
  /** Folder the stdio servers run in. */
  cwd: string;
  /** Per server. Default 30 s (npx may download the server first). */
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

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
  const base = { name: server.name, file: server.file };
  const env = options.env ?? process.env;
  // Loaded only here, so code that never lists tools (such as a hosted scan) never loads the MCP client.
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const client = new Client({ name: "ai-change-guard", version: "1" });
  try {
    let transport;
    if (server.url) {
      const headers = Object.fromEntries(Object.entries(server.headers ?? {}).map(([k, v]) => [k, expandVars(v, env)]));
      transport = new StreamableHTTPClientTransport(new URL(expandVars(server.url, env)), { requestInit: { headers } });
    } else if (server.command) {
      const { StdioClientTransport, getDefaultEnvironment } = await import("@modelcontextprotocol/client/stdio");
      const serverEnv = Object.fromEntries(Object.entries(server.env ?? {}).map(([k, v]) => [k, expandVars(v, env)]));
      transport = new StdioClientTransport({
        command: expandVars(server.command, env),
        args: server.args.map((a) => expandVars(a, env)),
        env: { ...getDefaultEnvironment(), ...serverEnv },
        cwd: options.cwd,
        stderr: "ignore",
      });
    } else {
      return { ...base, error: "no command or url in the config" };
    }
    const timeout = options.timeoutMs ?? 30_000;
    await withTimeout(client.connect(transport), timeout, server.name);
    const tools: { name: string; description?: string; inputSchema?: unknown }[] = [];
    let cursor: string | undefined;
    do {
      const page = await withTimeout(client.listTools(cursor ? { cursor } : {}), timeout, server.name);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor && tools.length < 10_000);
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
