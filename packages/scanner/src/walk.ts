import { readdir } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import type { FileKind } from "./detect.js";
import { isLockfile } from "./deps.js";

const SKIP_DIRS = new Set([
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
  ".cache",
]);

// npm and Python lockfiles are read for the AI package guard only (see `lock`), never scanned as code.
const SKIP_FILES = new Set([
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
]);

const CODE_EXTENSIONS = new Set([
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
  ".dart",
]);

const CONFIG_EXTENSIONS = new Set([".yaml", ".yml", ".json", ".toml", ".ini", ".properties", ".cfg"]);

export function fileKind(name: string): FileKind | null {
  const base = basename(name);
  if (base === ".env" || base.startsWith(".env.")) return "config";
  // Python dependency pins: requirements.txt, requirements-dev.txt, ...
  if (/^requirements[\w.-]*\.txt$/i.test(base)) return "config";
  if (base.endsWith(".min.js")) return null;
  const ext = extname(base).toLowerCase();
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (CONFIG_EXTENSIONS.has(ext)) return "config";
  return null;
}

/** Repository files the scanner reads besides code and config: dependency files and its own inputs. */
const EXTRA_FILES = new Set([".npmrc", "ai-stack.lock"]);

/**
 * Whether the scanner would read this repository path (slash-separated, relative to the root): the same rule
 * as walk(), so a hosted scan can download only these files instead of the whole repository.
 */
export function isScannablePath(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  const name = parts.pop();
  if (!name || parts.some((dir) => SKIP_DIRS.has(dir))) return false;
  if (isLockfile(name) || EXTRA_FILES.has(name)) return true;
  return !SKIP_FILES.has(name) && fileKind(name) !== null;
}

export interface WalkedFile {
  path: string;
  rel: string;
  kind: FileKind;
  /** A lockfile: read for its dependencies only. */
  lock?: true;
}

export async function* walk(root: string): AsyncGenerator<WalkedFile> {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile() || SKIP_FILES.has(entry.name)) continue;
      if (isLockfile(entry.name)) {
        yield { path: full, rel: relative(root, full).split(sep).join("/"), kind: "config", lock: true };
        continue;
      }
      const kind = fileKind(entry.name);
      if (kind) yield { path: full, rel: relative(root, full).split(sep).join("/"), kind };
    }
  }
}
