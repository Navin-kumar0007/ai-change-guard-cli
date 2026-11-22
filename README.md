# AI Change Guard

AI providers retire models on a schedule. When a model you call is retired, requests start failing, or get quietly rerouted to a different model that may answer differently. AI Change Guard finds every model your code uses, tells you which ones are retiring and when, and proves whether a replacement still works by replaying your real prompts on both models.

- **Scan:** finds model IDs and deprecated AI APIs in code and config (Python, JS/TS, Go, Java, YAML, JSON, `.env` and more) and checks them against a catalog of official retirement dates.
- **Replay:** runs your own prompts on the old and new model and flags broken JSON, changed tool calls, missing content, new refusals and drifting answers.
- **Import:** turns logs you already have (Langfuse, Helicone, OpenTelemetry, raw request logs) into a golden set, so you don't write tests by hand.
- **Prompt Repair:** when the new model breaks your JSON format, finds a prompt change that fixes it and proves it with a re-test.
- **Switch:** once the replay passes, changes the model ID across your code, or opens a pull request with the replay report as proof.
- **Token Saver:** points out common token waste (no output limit, no prompt caching, cache-breaking prompts, unbatched loops).
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

`import` reads JSON or JSONL exports from Langfuse, Helicone and OpenTelemetry (GenAI spans), or plain logs of OpenAI, Anthropic or Gemini requests, by recognising the request inside each record. It keeps up to 50 distinct prompts spread over the log (`--limit`), skips tool-call conversations and images, and adds checks from the logged answers: a JSON answer becomes a JSON check, a tool call becomes a tool check. The file holds real user messages, so read it before you commit it. No logs yet? Add the [recorder](packages/recorder/README.md) to your app (three lines in Node.js or Python): it saves your real AI calls to `ai-calls.jsonl` without headers or API keys, ready for `import`. You can also write prompts by hand (see [`examples/support-bot.jsonl`](examples/support-bot.jsonl)).

Then set your provider key in the environment and run:

```
export OPENAI_API_KEY=...        # or ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, ...
node packages/scanner/dist/cli.js replay --set prompts.jsonl --old openai:gpt-4o --new openai:gpt-6-luna --runs 3
```

Every prompt gets a verdict: same, changed, broken, or could not compare, with the reason. A spend cap (`--max-calls`, default 500) stops a run before it starts if it would make too many calls. Providers: OpenAI, Anthropic, Google Gemini, Groq, OpenRouter, Mistral and Ollama.

**Prompt Repair:** add `--repair`. When the new model breaks a prompt's JSON format (prose around the JSON, code fences, schema misses), AI Change Guard tries fixed, readable changes on the new model only: a JSON-only instruction in the system prompt (with your schema), then that plus the provider's JSON mode. Each try is re-tested with the same rules, and the first one that passes is shown as the exact change to make. `--repaired-set fixed.jsonl` writes your golden set with the working fixes applied, so you can re-run it. Repair calls come out of the same `--max-calls` budget; `--repaired-set` writes a new file with prompts only, without comments or extra fields.

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

## Project layout

| Package | What it does |
| --- | --- |
| `packages/catalog` | Retirement data and lookup |
| `packages/scanner` | File walker, model detection, report, the `ai-change-guard` CLI |
| `packages/llm` | Minimal provider client (fetch only, no SDKs), retries that honour rate limits |
| `packages/recorder` | Three-line recorder (Node.js and Python) that saves real AI calls for `import` |
| `packages/replay` | Golden sets, replay runner, verdict rules, reports |
| `action` | The GitHub Action |

`npm test` builds everything and runs the test suite. Requires Node 20 or later.

## License

[MIT](LICENSE)
