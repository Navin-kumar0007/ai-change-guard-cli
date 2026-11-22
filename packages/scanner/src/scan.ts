import { readFile, stat } from "node:fs/promises";
import { apis } from "@ai-change-guard/catalog";
import { compileApiRules, scanText, type Finding } from "./detect.js";
import { findSecurityIssues, type SecurityFinding } from "./security.js";
import { findTokenTips, type TokenTip } from "./tokens.js";
import { walk } from "./walk.js";

const MAX_FILE_BYTES = 1_000_000;

export interface ScanResult {
  root: string;
  filesScanned: number;
  aiFiles: number;
  callSites: number;
  findings: Finding[];
  tokenTips: TokenTip[];
  security: SecurityFinding[];
}

export async function scanDirectory(root: string): Promise<ScanResult> {
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`Not a folder: ${root}`);

  const rules = compileApiRules(apis);
  const result: ScanResult = { root, filesScanned: 0, aiFiles: 0, callSites: 0, findings: [], tokenTips: [], security: [] };

  for await (const file of walk(root)) {
    const size = (await stat(file.path)).size;
    if (size > MAX_FILE_BYTES) continue;
    const content = await readFile(file.path, "utf8");
    if (content.includes("\u0000")) continue;

    const scanned = scanText(file.rel, content, file.kind, rules);
    result.filesScanned++;
    if (scanned.isAiFile && file.kind === "code") result.aiFiles++;
    result.callSites += scanned.callSites;
    result.findings.push(...scanned.findings);
    if (scanned.isAiFile) result.tokenTips.push(...findTokenTips(file.rel, content, file.kind));
    result.security.push(...findSecurityIssues(file.rel, content, file.kind));
  }
  return result;
}
