import { readFileSync } from "node:fs";

export type Provider = "openai" | "anthropic" | "google" | "mistral";

export type Platform =
  | "openai-api"
  | "azure-openai"
  | "anthropic-api"
  | "aws-bedrock"
  | "gemini-api"
  | "vertex-ai"
  | "mistral-api";

export interface Source {
  url: string;
  checked: string;
}

export interface ModelEntry {
  id: string;
  provider: Provider;
  platform: Platform;
  retiresOn: string;
  reroutesTo?: string;
  replacement?: string;
  verified: boolean;
  note?: string;
  sources: Source[];
}

export interface ApiEntry {
  id: string;
  provider: Provider;
  name: string;
  patterns: string[];
  retiresOn: string;
  replacement?: string;
  verified: boolean;
  note?: string;
  sources: Source[];
}

/** US dollars per 1 million tokens. */
export interface TokenPrice {
  input: number;
  output: number;
}

export interface PriceEntry extends TokenPrice {
  id: string;
  provider: Provider;
  platform: Platform;
  /** Price per 1 million cache-read input tokens, when the provider lists one. */
  cachedInput?: number;
  /** Tokenizer family, when it matters for comparing token counts (see `tokenizers`). */
  tokenizer?: string;
  verified: boolean;
  note?: string;
  sources: Source[];
}

/** An announced price change: an introductory price ending, or a scheduled increase or cut. */
export interface PriceChange {
  id: string;
  provider: Provider;
  platform: Platform;
  /** First day the new price applies. */
  on: string;
  kind: "intro-ends" | "price-change";
  /** New prices; missing when the provider has not published them yet. */
  input?: number;
  output?: number;
  verified: boolean;
  note?: string;
  sources: Source[];
}

export interface TokenizerEntry {
  id: string;
  provider: Provider;
  relativeTo: string;
  /** Tokens this tokenizer produces for text that `relativeTo` turns into 1 token (about). */
  ratio: number;
  verified: boolean;
  note?: string;
  sources: Source[];
}

function load<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(`../data/${file}`, import.meta.url), "utf8")) as T;
}

export const models: readonly ModelEntry[] = load<{ models: ModelEntry[] }>("models.json").models;
export const apis: readonly ApiEntry[] = load<{ apis: ApiEntry[] }>("apis.json").apis;

const priceData = load<{ prices: PriceEntry[]; changes: PriceChange[]; tokenizers: TokenizerEntry[] }>("prices.json");
export const prices: readonly PriceEntry[] = priceData.prices;
export const priceChanges: readonly PriceChange[] = priceData.changes;
export const tokenizers: readonly TokenizerEntry[] = priceData.tokenizers;

export const defaultPlatform: Record<Provider, Platform> = {
  openai: "openai-api",
  anthropic: "anthropic-api",
  google: "gemini-api",
  mistral: "mistral-api",
};

export function lookupModel(id: string): ModelEntry[] {
  return models.filter((m) => m.id === id);
}

/** The list price on `platform` today (the catalog's checked price), or undefined when the catalog has none. */
export function lookupPrice(id: string, platform: Platform): PriceEntry | undefined {
  return prices.find((p) => p.id === id && p.platform === platform);
}

/** Announced price changes for a model, earliest first. */
export function lookupPriceChanges(id: string, platform: Platform): PriceChange[] {
  return priceChanges.filter((c) => c.id === id && c.platform === platform).sort((a, b) => a.on.localeCompare(b.on));
}

/**
 * The price that applies on `date` (YYYY-MM-DD): the list price with every announced change up to that day
 * applied. Undefined when the catalog has no price, or a change by then has no published new price.
 */
export function priceOn(id: string, platform: Platform, date: string): TokenPrice | undefined {
  const base = lookupPrice(id, platform);
  if (!base) return undefined;
  let price: TokenPrice = { input: base.input, output: base.output };
  for (const change of lookupPriceChanges(id, platform)) {
    if (change.on > date) break;
    if (change.input === undefined || change.output === undefined) return undefined;
    price = { input: change.input, output: change.output };
  }
  return price;
}

/**
 * About how many tokens model `to` uses for text that model `from` counts as 1 token: 1 when both use the
 * same tokenizer or the catalog does not know.
 */
export function tokenRatio(from: { id: string; platform: Platform }, to: { id: string; platform: Platform }): number {
  const a = lookupPrice(from.id, from.platform)?.tokenizer;
  const b = lookupPrice(to.id, to.platform)?.tokenizer;
  if (!a || !b || a === b) return 1;
  const forward = tokenizers.find((t) => t.id === b && t.relativeTo === a);
  if (forward) return forward.ratio;
  const back = tokenizers.find((t) => t.id === a && t.relativeTo === b);
  return back ? 1 / back.ratio : 1;
}

/**
 * The price a call to `id` is billed at on `date`: after a provider reroutes the model, calls are billed at
 * the target's rates. Undefined when either price is unknown on that day.
 */
export function billedPriceOn(id: string, platform: Platform, date: string): TokenPrice | undefined {
  const reroute = models.find((m) => m.id === id && m.platform === platform && m.reroutesTo && m.retiresOn <= date);
  return reroute?.reroutesTo ? priceOn(reroute.reroutesTo, platform, date) : priceOn(id, platform, date);
}

/** Today's date on this computer, YYYY-MM-DD. */
export function localToday(): string {
  return new Date().toLocaleDateString("en-CA");
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** $1.50, $0.10, $0.075, $0.00042: two decimals, more (up to six) only for amounts under 10 cents. */
export function formatUsd(amount: number): string {
  const abs = Math.abs(amount);
  const text = abs >= 0.1 || abs === 0 ? abs.toFixed(2) : abs.toFixed(6).replace(/(\.\d\d\d*?)0+$/, "$1");
  return `${amount < 0 ? "-" : ""}$${text}`;
}

/** US dollars for one call with these token counts. */
export function callCost(price: TokenPrice, inputTokens: number, outputTokens: number): number {
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
