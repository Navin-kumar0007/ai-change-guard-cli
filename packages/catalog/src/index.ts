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

function load<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(`../data/${file}`, import.meta.url), "utf8")) as T;
}

export const models: readonly ModelEntry[] = load<{ models: ModelEntry[] }>("models.json").models;
export const apis: readonly ApiEntry[] = load<{ apis: ApiEntry[] }>("apis.json").apis;

export const defaultPlatform: Record<Provider, Platform> = {
  openai: "openai-api",
  anthropic: "anthropic-api",
  google: "gemini-api",
  mistral: "mistral-api",
};

export function lookupModel(id: string): ModelEntry[] {
  return models.filter((m) => m.id === id);
}
