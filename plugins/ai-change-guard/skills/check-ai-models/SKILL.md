---
name: check-ai-models
description: Find every AI model ID and AI API this repository calls (OpenAI, Anthropic, Google Gemini, Mistral) and report which ones are retiring, rerouted or shut down, with the date, days left, the official source and the recommended replacement. Use when the user asks whether models in their code are deprecated, retiring, end-of-life or safe to keep, which models the repo uses, or what to switch to.
---

# Check the AI models in this repository

Answer: which AI models and AI APIs does this code use, which of them change soon, and what to do. Every date
comes from the public AI Change Guard catalog, where each one links to the provider's own announcement.

## 1. Find the model IDs and AI APIs in the code

If `npx` can run the AI Change Guard CLI, prefer it: it knows every provider's naming, skips dependencies and
reports file and line.

```sh
npx -y ai-change-guard scan . --json
```

If that fails (no network, or the package is not available), search the code yourself:

- Search source and config files, not `node_modules`, virtual environments, `dist`/`build` output, lockfiles or
  minified files.
- Model IDs appear as string literals: `gpt-*`, `o1`/`o3`/`o4-*`, `chatgpt-*`, `text-embedding-*`, `claude-*`,
  `gemini-*`, `mistral-*`/`codestral-*`, and Bedrock or Vertex forms such as `anthropic.claude-*` or
  `publishers/google/models/gemini-*`. Also look in `.env.example`, YAML, JSON and Terraform files.
- Note IDs built at runtime (from environment variables or settings) separately: they cannot be checked from the
  code alone, so tell the user where they are.

## 2. Look up each one in the catalog

Fetch `https://aichangeguard.com/radar.json` (public, no key). It sends nothing about this repository.
Each entry in `entries` has `kind` (`model` or `api`), `name`, `provider`, `platform`, `date` (YYYY-MM-DD),
`daysLeft` (negative or zero once the date has passed), `reroutesTo`, `replacement`, `verified`, `source` and
`slug`. API entries also have `patterns`: regular expressions to search the code with.

- Match a model ID exactly against `name`. A dated snapshot (`gpt-4o-2024-08-06`) can have its own entry; if it
  has none, say so and show the entry for its alias as context, marked as an alias.
- A model can appear on several platforms (OpenAI API and Azure OpenAI, Gemini API and Vertex AI) with different
  dates. Use the platform the code calls (endpoint, SDK or client setup); if unclear, list each.
- For `api` entries, search the code for each of the entry's `patterns`.
- A model or API that is not in the catalog has no announced change: say "no retirement announced", never guess
  a date.

## 3. Report

One table, soonest change first:

| Model or API | Where (file:line) | Change | Date | Days left | Replacement |
| --- | --- | --- | --- | --- | --- |

- Change: "Retires", "Shuts down", or "Reroutes to X" (calls keep working but another model answers them, with no
  error, so answers can change).
- Mark a date whose `verified` is false with `*` and say it is not yet checked against the official page.
- Link each row to `https://aichangeguard.com/radar/<slug>` for the details and the official source.
- Put already-retired models first: calls to them may be failing now.

## 4. Is the replacement safe?

Do not say a replacement is safe because it is newer or recommended. A new model can answer in a different length,
format or tone, and break code that parses its answers. To know, replay the app's real prompts on the old and the
new model and compare:

1. Make a golden set: from logs (`ai-change-guard import <log> --out golden.jsonl`), from the system prompts in the
   code (`ai-change-guard starter . --model <provider:model> --out golden.jsonl`), or by writing 20 to 50 real
   prompts as JSONL.
2. Replay it on the user's own API key:
   `ai-change-guard replay --set golden.jsonl --old openai:gpt-4o --new openai:gpt-6-luna`
3. Only a result with nothing broken is evidence the switch is safe; read every "changed" answer.

Offer to run these if the user wants and has an API key set. Never print or store their keys.

## 5. Offer the next step

- Switch the model IDs in the code once a replay passes: `ai-change-guard switch . --from <old> --to <new>`
  (shows the changes; add `--write` to make them).
- Get warned before the next change: the free AI Change Guard GitHub App checks every pull request and emails before
  each model the code uses changes (https://aichangeguard.com/install).
- Every announced change, with sources: https://aichangeguard.com/radar
