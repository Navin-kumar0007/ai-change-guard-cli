# ai-change-guard

AI providers retire models on a schedule. When a model you call is retired, requests start failing, or get quietly rerouted to a different model that may answer differently. AI Change Guard finds every model your code uses, tells you which ones are retiring and when, and proves whether a replacement still works by replaying your real prompts on both models.

Runs on your machine or in your CI. Your code and API keys never leave it.

## Scan

```sh
npx ai-change-guard scan .
npx ai-change-guard scan https://github.com/owner/repo
```

Finds model IDs and deprecated AI APIs in Python, JS/TS, Go, Java, YAML, JSON, `.env` and more, checks them against a catalog of official retirement dates (every date keeps its source link), and flags AI security mistakes and token waste. Options: `--json`, `--fail-on retired|retiring` (exit code 1 for CI).

## Test a model switch on your real prompts

```sh
npx ai-change-guard import exported-logs.jsonl --out golden.jsonl --model gpt-4o
npx ai-change-guard replay --set golden.jsonl --old openai:gpt-4o --new openai:gpt-5
```

The replay flags broken JSON, changed tool calls, missing content, new refusals and drifting answers. Your provider key comes from the environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`).

Also: `starter` (a golden set from the prompts in your code), `switch` (change the model ID everywhere, or open a pull request with the report), `baseline` and `watch` (nightly check for silent model changes), `fallback` (tested backup models for LiteLLM or OpenRouter).

Full documentation, the GitHub Action and the MCP server: https://github.com/Navin-kumar0007/ai-change-guard-cli

MIT licensed.
