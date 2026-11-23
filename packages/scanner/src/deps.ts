// Reads the dependencies a project installs from its manifests and lockfiles (npm and Python), so the
// AI package guard can check them. Lockfiles give exact versions; manifests give names (and pinned versions).
import { basename } from "node:path";

export type Ecosystem = "npm" | "PyPI";

export interface Dependency {
  ecosystem: Ecosystem;
  name: string;
  /** Exact version when the file pins one (lockfiles always do). */
  version?: string;
  file: string;
  line: number;
  /** The file installs from a private package index or registry, so "not on the public registry" proves nothing. */
  privateIndex?: true;
}

/** A dependency before its line number is looked up (only done for the few worth reporting). */
export interface RawDependency extends Omit<Dependency, "line"> {
  needle: string;
}

const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock", "uv.lock", "Pipfile.lock"]);

export function isLockfile(name: string): boolean {
  return LOCKFILES.has(basename(name));
}

export function isDependencyFile(name: string): boolean {
  const base = basename(name);
  return LOCKFILES.has(base) || base === "package.json" || /^requirements[\w.-]*\.txt$/i.test(base);
}

/** PyPI treats "Guardrails_AI", "guardrails.ai" and "guardrails-ai" as one name (PEP 503). */
export function normalizeName(ecosystem: Ecosystem, name: string): string {
  return ecosystem === "PyPI" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name;
}

const EXACT_VERSION = /^v?(\d+\.\d+(?:\.\d+)?(?:[-.+]?[0-9A-Za-z.]+)?)$/;

type Raw = { name: string; version?: string; needle: string; privateIndex?: true };

/** Specs that don't come from the public registry: local workspaces, files, links and git. */
const NOT_REGISTRY = /^(workspace:|file:|link:|portal:|git\+|git:|github:|gitlab:|bitbucket:|https?:)/;

function fromPackageLock(content: string): Raw[] {
  const data = JSON.parse(content) as { packages?: Record<string, { version?: string; link?: boolean; name?: string }>; dependencies?: Record<string, unknown> };
  const out: Raw[] = [];
  if (data.packages) {
    for (const [path, info] of Object.entries(data.packages)) {
      // Keys without node_modules/ are the root and workspace folders, not installed packages.
      const at = path.lastIndexOf("node_modules/");
      if (at < 0 || info.link) continue;
      // An alias ("my-ai": "npm:real-pkg@1") is installed under the alias path but is the real package.
      const name = info.name ?? path.slice(at + "node_modules/".length);
      if (name && info.version) out.push({ name, version: info.version, needle: `"${path}"` });
    }
    return out;
  }
  // lockfileVersion 1: nested "dependencies" objects.
  const walk = (deps: Record<string, unknown> | undefined) => {
    for (const [name, value] of Object.entries(deps ?? {})) {
      const info = value as { version?: string; dependencies?: Record<string, unknown> };
      if (info.version) out.push({ name, version: info.version, needle: `"${name}"` });
      walk(info.dependencies);
    }
  };
  walk(data.dependencies);
  return out;
}

function fromPackageJson(content: string): Raw[] {
  const data = JSON.parse(content) as Record<string, unknown>;
  const out: Raw[] = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = data[field];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof spec !== "string" || NOT_REGISTRY.test(spec.trim())) continue;
      const alias = aliasTarget(spec.trim());
      const exact = EXACT_VERSION.exec((alias ? alias.spec : spec.trim()).replace(/^=/, ""));
      out.push({ name: alias?.name ?? name, ...(exact ? { version: exact[1]! } : {}), needle: `"${name}"` });
    }
  }
  return out;
}

/** "npm:litellm-js@1.2.3" -> { name: "litellm-js", spec: "1.2.3" }; "npm:@scope/x" -> { name: "@scope/x", spec: "" }. */
function aliasTarget(spec: string): { name: string; spec: string } | undefined {
  if (!spec.startsWith("npm:")) return undefined;
  const rest = spec.slice(4);
  // "npm:^5.0.0" (yarn berry) is just a version range of the same package, not an alias.
  if (!rest || /^[\d~^<>=*]/.test(rest)) return undefined;
  const at = rest.indexOf("@", 1);
  return at < 0 ? { name: rest, spec: "" } : { name: rest.slice(0, at), spec: rest.slice(at + 1) };
}

function fromPnpmLock(content: string): Raw[] {
  const out: Raw[] = [];
  // v6+: "  /name@1.2.3:", "  name@1.2.3:" or "  '@scope/name@1.2.3':"; v5: "  /name/1.2.3:"
  // Versions stop at "(" (v6+ peers) or "_" (v5 peers): "/langchain/0.1.0_openai@4.0.0".
  const re = /^ {2}['"]?\/?((?:@[^/@\s'"]+\/)?[^/@\s'"]+)[@/](\d[^\s:'"(_]*)/gm;
  for (const m of content.matchAll(re)) out.push({ name: m[1]!, version: m[2]!, needle: m[0]! });
  return out;
}

function fromYarnLock(content: string): Raw[] {
  const out: Raw[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]!;
    if (!header || header.startsWith(" ") || header.startsWith("#") || !header.endsWith(":")) continue;
    const first = header.replace(/:$/, "").split(",")[0]!.trim().replace(/^"|"$/g, "");
    const at = first.indexOf("@", 1);
    if (at < 1) continue;
    const rest = first.slice(at + 1);
    // "x@npm:openai@^4" is the real package openai under the alias x.
    const name = rest.startsWith("npm:") ? (aliasTarget(rest)?.name ?? first.slice(0, at)) : first.slice(0, at);
    for (let j = i + 1; j < lines.length && lines[j]!.startsWith(" "); j++) {
      const v = /^\s+version:?\s+"?([^"\s]+)"?/.exec(lines[j]!);
      if (v) {
        out.push({ name, version: v[1]!, needle: header });
        break;
      }
    }
  }
  return out;
}

/** uv.lock "source = { editable = "." }" and the like, poetry.lock "[package.source] type = "directory"". */
const LOCAL_SOURCE = /^source\s*=\s*\{[^}]*\b(editable|virtual|directory|path|git)\s*=|^\[package\.source\][^[]*?^type\s*=\s*"(directory|file|git|url)"/ms;
/** uv.lock "source = { registry = "https://pkgs.acme.dev/simple" }": a package index other than PyPI. */
const OTHER_INDEX = /^source\s*=\s*\{\s*registry\s*=\s*"(?!https:\/\/pypi\.org\/)/m;

/** poetry.lock and uv.lock: [[package]] tables with name = "..." and version = "...". */
function fromTomlLock(content: string): Raw[] {
  const out: Raw[] = [];
  for (const block of content.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    // The project itself, its workspace members and git or path packages don't come from PyPI.
    if (LOCAL_SOURCE.test(block)) continue;
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name) out.push({ name, ...(version ? { version } : {}), needle: `name = "${name}"`, ...(OTHER_INDEX.test(block) ? { privateIndex: true as const } : {}) });
  }
  return out;
}

function fromPipfileLock(content: string): Raw[] {
  const data = JSON.parse(content) as Record<string, Record<string, { version?: string }> | undefined>;
  const out: Raw[] = [];
  for (const section of ["default", "develop"]) {
    for (const [name, info] of Object.entries(data[section] ?? {})) {
      const version = info?.version?.replace(/^==/, "");
      out.push({ name, ...(version ? { version } : {}), needle: `"${name}"` });
    }
  }
  return out;
}

function fromRequirements(content: string): Raw[] {
  const out: Raw[] = [];
  const privateIndex = /^\s*(--index-url|--extra-index-url|-i\s)/m.test(content);
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(?:===?\s*([^\s;,]+))?/.exec(line);
    if (m) out.push({ name: m[1]!, ...(m[2] && !m[2].includes("*") ? { version: m[2] } : {}), needle: raw, ...(privateIndex ? { privateIndex } : {}) });
  }
  return out;
}

/** Dependencies declared in one file, or [] for a file that is not a manifest or cannot be read. */
export function parseDependencies(file: string, text: string): RawDependency[] {
  const base = basename(file);
  const content = text.replace(/\r\n?/g, "\n");
  let ecosystem: Ecosystem;
  let raw: Raw[];
  try {
    if (base === "package-lock.json" || base === "npm-shrinkwrap.json") [ecosystem, raw] = ["npm", fromPackageLock(content)];
    else if (base === "package.json") [ecosystem, raw] = ["npm", fromPackageJson(content)];
    else if (base === "pnpm-lock.yaml") [ecosystem, raw] = ["npm", fromPnpmLock(content)];
    else if (base === "yarn.lock") [ecosystem, raw] = ["npm", fromYarnLock(content)];
    else if (base === "poetry.lock" || base === "uv.lock") [ecosystem, raw] = ["PyPI", fromTomlLock(content)];
    else if (base === "Pipfile.lock") [ecosystem, raw] = ["PyPI", fromPipfileLock(content)];
    else if (/^requirements[\w.-]*\.txt$/i.test(base)) [ecosystem, raw] = ["PyPI", fromRequirements(content)];
    else return [];
  } catch {
    return [];
  }
  return raw.map((r) => ({
    ecosystem,
    name: normalizeName(ecosystem, r.name),
    ...(r.version ? { version: r.version } : {}),
    file,
    needle: r.needle,
    ...(r.privateIndex ? { privateIndex: r.privateIndex } : {}),
  }));
}

/** The package a package.json itself defines (a workspace in a monorepo), so other workspaces' use of it is not checked. */
export function ownPackageName(file: string, content: string): string | undefined {
  if (basename(file) !== "package.json") return undefined;
  try {
    const name = (JSON.parse(content) as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

/** What an .npmrc points at another registry: everything ("registry=") and/or scopes ("@acme:registry="). */
export function privateRegistries(npmrc: string): { all: boolean; scopes: string[] } {
  const all = /^\s*registry\s*=/m.test(npmrc);
  const scopes = [...npmrc.matchAll(/^\s*(@[^:\s]+):registry\s*=/gm)].map((m) => m[1]!);
  return { all, scopes };
}

/** Line number (1-based) of the first line containing `needle`, or 1. */
export function lineOf(content: string, needle: string): number {
  const at = content.indexOf(needle);
  if (at < 0) return 1;
  let line = 1;
  for (let i = content.indexOf("\n"); i >= 0 && i < at; i = content.indexOf("\n", i + 1)) line++;
  return line;
}
