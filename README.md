# AI Change Guard

AI providers retire models on a schedule. When a model you call is retired, requests start failing, or get quietly rerouted to a different model that may answer differently. AI Change Guard finds every model your code uses, tells you which ones are retiring and when, and proves whether a replacement still works by replaying your real prompts on both models.

- **Scan:** finds model IDs and deprecated AI APIs in code and config (Python, JS/TS, Go, Java, YAML, JSON, `.env` and more) and checks them against a catalog of official retirement dates.
- **Replay:** runs your own prompts on the old and new model and flags broken JSON, changed tool calls, missing content, new refusals and drifting answers.
- **Starter set:** no logs yet? Finds the system prompts in your code and generates realistic test messages for them.
- **Import:** turns logs you already have (Langfuse, Helicone, OpenTelemetry, raw request logs) into a golden set, so you don't write tests by hand.
- **Prompt Repair:** when the new model breaks your JSON format, finds a prompt change that fixes it and proves it with a re-test.
- **Nightly watch:** asks the model you already use again every night and compares with a committed baseline, so a silent model update or a reroute to another model reaches you as one alert (job failure, email, Slack) instead of as broken answers in production.
- **Tested fallbacks:** `fallback` replays your golden set on backup models and writes a LiteLLM or OpenRouter fallback config with only the ones that broke nothing, so an outage switches to a model you know works.
- **ai-stack.lock:** `lock` writes one committed file listing every model (with its retirement date, reroute and price as known that day), deprecated AI API, AI package and golden-set baseline your app depends on. `lock --check`, every scan and the pull request check compare it with the code and today's catalog. They say when the code changed without the lock, or when the catalog changed since it was written.
- **Money-Finder:** `save` replays your golden set on the nearest cheaper models of the same provider and recommends one only if nothing broke and at most 2% of answers changed, with the saving per call and per month measured on your own prompts. The Action can open the switch pull request with the savings card.
- **Switch:** once the replay passes, changes the model ID across your code, or opens a pull request with the replay report as proof.
- **AI security check:** flags AI-specific mistakes with zero AI calls: AI keys in code or the browser, model output passed to eval, a shell, SQL or raw HTML, user input inside the system prompt, agent tools that delete, pay or send without a confirmation step, and unpinned MCP servers (mapped to the OWASP Top 10 for LLM and agentic apps; advisory, never a guarantee).
- **AI package guard:** reads your lockfiles and manifests (npm, pnpm, yarn, pip, Poetry, uv, Pipenv) and flags AI SDK, agent and MCP releases that were published with malicious code, such as litellm 1.82.7, 1.82.8 and 1.107.0, mistralai 2.4.6, guardrails-ai 0.10.1 and @mastra/core 1.42.1, each with its OSV advisory. With `--online` it also asks OSV for newer advisories, and npm or PyPI whether AI-sounding packages exist and how old they are: an invented or days-old name is a sign of a fake package.
- **Price changes:** the scan lists announced price changes for the models you use: introductory prices ending, scheduled increases, and reroutes billed at another model's rates. It also shows each suggested replacement's price, and warns when the replacement's tokenizer uses more tokens for the same text. `cost` turns that into dollars a month from your real call volume. A replay shows the cost per call on both models.
- **Token Saver:** points out common token waste (no output limit, no prompt caching, cache-breaking prompts, unbatched loops). **Verified Prompt Slimming** (`slim`) goes further: a model rewrites each system prompt shorter, your golden set is replayed with the old and the new prompt, and the shorter one is proposed only if every answer still passes, with the measured saving.
- **Inside your AI assistant:** an [MCP server](packages/mcp/README.md) lets Claude Code, Cursor and other MCP clients scan your repo, look up retirement dates, plan a switch and test it.
- **Runs where you are:** a CLI on your machine and a GitHub Action in your CI. Your code and API keys never leave your machine or runner.

## Quick start

```
git clone https://github.com/Navin-kumar0007/ai-change-guard-cli
cd ai-change-guard-cli
npm install
npm run build
node packages/scanner/dist/cli.js scan /path/to/your/app
```

Example output:

```
AI Change Guard scan: ./my-app
2 files scanned · 2 files use an AI SDK · 2 AI call sites · 2 model IDs found · today 2026-11-21

Models
  STATUS                           MODEL                       PLATFORM       WHERE
  RETIRED since 2025-10-28         claude-3-5-sonnet-20241022  anthropic-api  src/bot.py:3
  RETIRES in 54 days (2027-01-14)  gpt-4o-2024-08-06           openai-api     app/chat.ts:3
  claude-3-5-sonnet-20241022: replacement: claude-sonnet-5-5
  gpt-4o-2024-08-06: replacement: gpt-6-luna
```

Options: `--json`, `--fail-on retired|retiring` (exit code 1 for CI), `--today YYYY-MM-DD`.

## Test a model switch on your own prompts

Get a golden set of real prompts. The quickest way is from logs you already have:

```
node packages/scanner/dist/cli.js import exported-logs.jsonl --out golden.jsonl --model gpt-4o
```

`import` reads JSON or JSONL exports from Langfuse, Helicone and OpenTelemetry (GenAI spans), or plain logs of OpenAI, Anthropic or Gemini requests, by recognising the request inside each record. It keeps up to 50 distinct prompts spread over the log (`--limit`), skips tool-call conversations and images, and adds checks from the logged answers: a JSON answer becomes a JSON check, a tool call becomes a tool check. The file holds real user messages, so read it before you commit it. No logs at all yet? `starter` finds the system prompts in your code and has a model write realistic user messages for each one (one call per prompt, on your own key):

```
node packages/scanner/dist/cli.js starter ./my-app --model openai:gpt-4o-mini --out golden.jsonl
```

The system prompts stay exactly as written in your code, and a JSON check is added where your code expects JSON. The user messages are made up, so read them and replace the set with real calls when you can. To collect real calls, add the [recorder](packages/recorder/README.md) to your app (three lines in Node.js or Python): it saves your real AI calls to `ai-calls.jsonl` without headers or API keys, ready for `import`. You can also write prompts by hand (see [`examples/support-bot.jsonl`](examples/support-bot.jsonl)).

Then set your provider key in the environment and run:

```
export OPENAI_API_KEY=...        # or ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, ...
node packages/scanner/dist/cli.js replay --set prompts.jsonl --old openai:gpt-4o --new openai:gpt-6-luna --runs 3
```

Every prompt gets a verdict: same, changed, broken, or could not compare, with the reason. A spend cap (`--max-calls`, default 500) stops a run before it starts if it would make too many calls. Providers: OpenAI, Anthropic, Google Gemini, Groq, OpenRouter, Mistral and Ollama.

**Prompt Repair:** add `--repair`. When the new model breaks a prompt's JSON format (prose around the JSON, code fences, schema misses), AI Change Guard tries fixed, readable changes on the new model only: a JSON-only instruction in the system prompt (with your schema), then that plus the provider's JSON mode. Each try is re-tested with the same rules, and the first one that passes is shown as the exact change to make. `--repaired-set fixed.jsonl` writes your golden set with the working fixes applied, so you can re-run it. Repair calls come out of the same `--max-calls` budget; `--repaired-set` writes a new file with prompts only, without comments or extra fields.

## Inside Claude Code and Cursor

Ask your AI coding tool "are any models in this repo retiring, and what should I switch to?".

**Claude Code:** install the plugin, then ask, or run `/ai-change-guard:check-ai-models`:

```
/plugin install ai-change-guard --marketplace Navin-kumar0007/ai-change-guard-cli
```

On Claude Code older than 2.1.275, add the marketplace first: `/plugin marketplace add Navin-kumar0007/ai-change-guard-cli`, then `/plugin install ai-change-guard@ai-change-guard`.

**Cursor:** copy [`integrations/cursor/ai-change-guard.mdc`](integrations/cursor/ai-change-guard.mdc) into your project's `.cursor/rules/`.

The skill finds every model ID and AI API in the code, looks each one up in the public catalog (`https://ai-change-guard.vercel.app/radar.json`; nothing about your code is sent), and reports the date, days left, the official source and the replacement. It does not call the replacement "safe" without a replay of your own prompts, and it shows how to run one.

## Leaving OpenAI Evals (it shuts down on 30 November 2026)

OpenAI made Evals read-only on 31 October 2026 and shuts it down on 30 November, with no export button. The API still returns your evals until then, so save them now:

```sh
OPENAI_API_KEY=sk-... node packages/scanner/dist/cli.js evals-export --out openai-evals --golden golden.jsonl
```

It saves every eval with its graders, every run with its settings, each run's recorded calls (the exact messages sent, the model and its answer) and the dataset files you uploaded, one folder per eval. It only reads; nothing in your OpenAI account changes. Use a key of the project that owns the evals.

`--golden` also turns the recorded calls into a golden set: the system prompt, the user messages, the model's settings, and a JSON check where the answers were JSON. Replay it on a new model whenever one changes (see above), or keep the saved files and the dataset for Promptfoo, which OpenAI suggests.

## ai-stack.lock: your AI dependencies in one file

```sh
node packages/scanner/dist/cli.js lock ./my-app           # writes my-app/ai-stack.lock; commit it
node packages/scanner/dist/cli.js lock ./my-app --check   # exit code 1 when it no longer matches
```

The file lists each model with the files that use it, plus what the catalog said about it that day: retirement date, reroute, replacement, list price and announced price changes. It also lists deprecated AI APIs, AI packages with their versions, and the golden-set baselines (`*.baseline.json`) with the model each one verified. It records file names rather than line numbers and has no timestamp, so it only changes when the AI stack does.

`--check` (and every scan, and the pull request check) reports two kinds of difference:

- **Out of date with the code:** a model or AI package added, removed or changed without updating the lock. A model switched without making a new baseline also counts. Run `lock` again and commit, so the pull request shows the AI stack change.
- **Changed in the catalog:** the code is the same, but something about a model changed. That can be a retirement announced or moved, a reroute or replacement added, or a new list price or announced price change. This is what a nightly `lock --check` catches.
- **Model switched without a new baseline:** a golden-set baseline still verifies a model the code no longer uses. Make a new baseline for the model in use.

## Money-Finder: a cheaper model that answers the same way

```sh
node packages/scanner/dist/cli.js save --set golden.jsonl --model openai:gpt-5.5 --calls-per-month 100000
```

```
SAVE  openai:gpt-5.5 → openai:gpt-5.4: 50% cheaper per call ($0.011 → $0.0055), about $550 a month
      25 same · 0 changed · 0 broken on 25 prompts (3 runs each)
      Switch: ai-change-guard switch . --from gpt-5.5 --to gpt-5.4 --write
```

Without `--candidates`, it tests the two nearest cheaper models on the same provider, so the same API key works. Previews, dated snapshot IDs and models retiring within 90 days are skipped. Prices are taken at the higher of today and two months from now, so an introductory price that is about to end can't win. A candidate passes only with nothing broken and at most 2% of prompts answered differently. The cost per call uses the tokens measured in the replay, so a tokenizer that uses more tokens is counted. `--log ai-calls.jsonl` takes the monthly volume from the recorder. Cost: prompts × runs × (1 + candidates) calls.

## Verified Prompt Slimming: a shorter system prompt, proved on your prompts

```sh
node packages/scanner/dist/cli.js slim --set golden.jsonl --model openai:gpt-5.5 --calls-per-month 100000 --write .
```

```
System prompt "You are the order assistant for Acme Store. Please always read the cust…" (1840 characters, 25 prompts)
  SAVE  concise rewrite, 910 characters: 33% cheaper per call (612 → 380 input tokens per call, $0.0021 → $0.0014 per call, about $70 a month)
        25 same · 0 changed · 0 broken on 25 prompts
  SKIP  minimal: 2 prompts broken in at least one run (first: order-7, not valid JSON)
```

For each system prompt in the golden set (the most-used first, `--max-prompts 3`), a model rewrites it twice, about 30% shorter and as short as it can be, keeping every rule, the output format and every template placeholder (`--writer` picks that model; default `--model`). Both rewrites are replayed on your own model against the original. A rewrite passes only with nothing broken, at most 2% of prompts answered differently and a measured saving of at least 3% per call; the saving uses the tokens measured in the replay, so longer answers count against it. A system prompt needs at least 3 prompts in the golden set. `--write FOLDER` puts each passing prompt into the code where it is written as one plain string literal (Python, JavaScript, TypeScript, Go); prompts joined from pieces or built at runtime are listed to change by hand. Cost per system prompt: 2 writer calls + prompts × runs × 3 calls.

## Backup models for an outage

```
node packages/scanner/dist/cli.js fallback --set golden.jsonl --model openai:gpt-4o \
  --candidates anthropic:claude-sonnet-5-5,google:gemini-3.1-flash-lite --format litellm --out litellm-config.yaml
```

Your model answers the golden set once; each candidate answers it too and is judged against those answers. Only candidates with nothing broken go into the config, fewest changed answers first. `--format litellm` writes a LiteLLM proxy `config.yaml` (`router_settings.fallbacks`, keys read from the environment); `--format openrouter` writes the `models` fallback list for OpenRouter requests and lists the ids to check on openrouter.ai/models. Cost: prompts × runs × (1 + candidates) calls.

## AI packages: malicious releases and fake names

The scan reads `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `requirements*.txt` and `package.json`. It keeps only AI packages: SDKs, agent frameworks, MCP, vector stores and AI-sounding names. It then checks their exact versions against the releases in [`packages/catalog/data/packages.json`](packages/catalog/data/packages.json) that were published with malicious code. A match prints a HIGH finding with the advisory link, and the scan exits with code 1.

```sh
node packages/scanner/dist/cli.js scan ./my-app --online
```

`--online` adds three lookups:

- OSV (osv.dev) for malicious-code advisories newer than the catalog.
- npm or PyPI for AI-sounding names the catalog doesn't list. A name that isn't on the registry may be one an AI assistant invented. Anyone could publish under it.
- The same registries for names first published in the last 30 days.

It sends package names and versions only, never code. It skips packages from a private index or registry, the repository's own workspace packages, and npm scopes it doesn't know. Ordinary vulnerabilities (CVEs) are left to Dependabot, Snyk and similar tools; this check is only about malicious and fake AI packages.

## What price changes cost you

The scan lists announced price changes for the models in your code. To see the effect on your bill, give `cost` your real call volume: the [recorder](packages/recorder/README.md)'s `ai-calls.jsonl`, or the numbers yourself.

```sh
node packages/scanner/dist/cli.js cost ./my-app --log ai-calls.jsonl            # add --sample 0.2 if the recorder kept 1 call in 5
node packages/scanner/dist/cli.js cost --model gemini-3.8-flash --calls 50000 --input-tokens 1500 --output-tokens 400
```

```
gemini-3.8-flash (gemini-api): about 50,000 calls a month · 1,500 input / 400 output tokens per call · about $131 a month now
  gemini-3.8-flash: price rises on 2027-01-01 (in 39 days): $0.75 → $1.50 input, $3.75 → $7.50 output per 1M tokens (+100%)
  => about $263 a month (+$131 a month)
```

Estimates use list prices: no batch, cache or volume discounts. A log is scaled from the days it covers to 30. When a provider has announced that a price ends but not published the new one, `cost` says so; it does not guess.

## Switch the model in your code

After a replay passes, change every exact use of the old model ID:

```
node packages/scanner/dist/cli.js switch ./my-app --from gpt-4o --to gpt-6-luna          # shows what would change
node packages/scanner/dist/cli.js switch ./my-app --from gpt-4o --to gpt-6-luna --write  # changes the files
```

Only string literals and config values that are exactly the model ID change (a gateway prefix such as `openai/` is kept), so `gpt-4o` never touches `gpt-4o-mini`. Fine-tuned models, Bedrock IDs and Azure deployment names are listed for you to change by hand.

## GitHub Action

```yaml
- uses: actions/checkout@v4
- uses: Navin-kumar0007/ai-change-guard-cli@v1
  with:
    fail-on: retired
```

Results appear in the run's Summary tab. The Action can also run a replay with keys from your repository secrets, and open a pull request that switches the model once the replay passes; see [action/README.md](action/README.md).

## The retirement catalog

[`packages/catalog/data/models.json`](packages/catalog/data/models.json) lists retirement and reroute dates for OpenAI, Azure OpenAI, Anthropic, Google Gemini and Vertex AI, Amazon Bedrock and Mistral models, each with links to the official source. Entries marked `"verified": false` have not been confirmed on an official page, and the CLI marks them with `*`. Dates change: if you spot a missing or wrong one, open an issue or pull request with the official link.

[`packages/catalog/data/prices.json`](packages/catalog/data/prices.json) holds list prices in US dollars per 1M tokens for OpenAI, Anthropic and the Gemini API, copied from each provider's pricing page. It also holds announced price changes, and tokenizer differences: Claude Opus 4.7 and later produce about 30% more tokens for the same text. Prices are per platform, so a Gemini API price says nothing about Vertex AI.

## Project layout

| Package | What it does |
| --- | --- |
| `packages/catalog` | Retirement data and lookup |
| `packages/scanner` | File walker, model detection, report, the `ai-change-guard` CLI |
| `packages/llm` | Minimal provider client (fetch only, no SDKs), retries that honour rate limits |
| `packages/mcp` | MCP server for AI coding assistants (Claude Code, Cursor): scan, look up, plan and test a model switch |
| `packages/recorder` | Three-line recorder (Node.js and Python) that saves real AI calls for `import` |
| `packages/replay` | Golden sets, replay runner, verdict rules, reports |
| `action` | The GitHub Action |

`npm test` builds everything and runs the test suite. Requires Node 20 or later.

## License

[MIT](LICENSE)
