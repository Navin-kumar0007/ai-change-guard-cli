# AI Change Guard GitHub Action

Runs inside your own CI. Finds retired and retiring AI models and shut-down AI APIs in your code, and can replay your real prompts on the model you use today and the one you plan to switch to. Your API keys stay in your GitHub secrets: the Action calls the providers directly from your runner and sends nothing to AI Change Guard.

## Scan only (no API keys needed)

```yaml
# .github/workflows/ai-change-guard.yml
name: AI Change Guard
on: [pull_request, push]
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Navin-kumar0007/ai-change-guard-cli@v1
        with:
          fail-on: retired   # retired | retiring (within 90 days) | none
```

The results appear in the run's **Summary** tab.

## Test a model switch on your own prompts

Save a golden set of real prompts as JSONL (see [`examples/support-bot.jsonl`](../examples/support-bot.jsonl)), add your provider key as a repository secret, then:

```yaml
      - uses: Navin-kumar0007/ai-change-guard-cli@v1
        with:
          prompts: tests/golden.jsonl
          old-model: openai:gpt-4o
          new-model: openai:gpt-6-luna
          runs: 3
          concurrency: 2
          max-calls: 300          # refuses to start above this many calls
          replay-fail-on: broken  # broken | changed | none
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Providers: `openai`, `anthropic`, `google`, `groq`, `openrouter`, `mistral`, `ollama`. Keys are read from `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and so on.

Pull requests from forks do not receive your secrets, so the replay step cannot run on them.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `path` | `.` | Folder to scan |
| `fail-on` | `retired` | Fail when a model or API is `retired`, `retiring` (within 90 days), or `none` |
| `prompts` | | Golden set (JSONL) for a replay |
| `old-model`, `new-model` | | `provider:model` |
| `runs` | `3` | Runs per prompt on each model |
| `concurrency` | `2` | Calls in flight; use `1` on free-tier keys |
| `max-calls` | `300` | Spend cap for one replay |
| `replay-fail-on` | `broken` | Fail when a prompt is `broken`, `changed`, or `none` |

## Development

`npm run build:action` type-checks, bundles `src/main.ts` into `bundle/index.js`, and copies the catalog into `data/`. Commit both: GitHub runs the bundle without installing dependencies. A test fails if `data/` falls behind `packages/catalog/data`.
