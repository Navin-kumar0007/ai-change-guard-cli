# AI Change Guard MCP server

Lets AI coding assistants (Claude Code, Cursor, Claude Desktop, any MCP client) answer: *are any models in this repo retiring, what replaces them, and is the switch safe?*

It runs on your machine, started by your assistant. Your code and API keys never leave it.

## Tools

| Tool | What it does | Changes anything? |
| --- | --- | --- |
| `scan_ai_models` | Every AI model ID and deprecated AI API in the project, with status, retirement date, replacement and file:line | No |
| `model_info` | Retirement or reroute date, replacement and official sources for one model | No |
| `list_retirements` | Upcoming retirements, by provider and number of days | No |
| `plan_model_switch` | The exact lines that would change for a switch, and the uses to change by hand | No (your assistant applies the edits) |
| `test_model_switch` | Replays your golden set on the old and new model and reports same / changed / broken, with optional Prompt Repair | No files; it calls the providers with your API keys and costs money, so assistants are told to ask you first |

Every path is resolved inside the project folder; anything outside it is refused.

## Set up

The server is not on npm yet (it will be at launch). Until then, build it from this repository (`npm install && npm run build`) and point your assistant at `packages/mcp/dist/main.js`. The server works on the folder it is started in; set `ACG_ROOT` to point it elsewhere.

**Claude Code** (from your project folder):

```
claude mcp add ai-change-guard -- node /path/to/ai-change-guard-cli/packages/mcp/dist/main.js
```

**Cursor** (`.cursor/mcp.json` in your project) or **Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ai-change-guard": {
      "command": "node",
      "args": ["/path/to/ai-change-guard-cli/packages/mcp/dist/main.js"],
      "env": { "ACG_ROOT": "/path/to/your/project" }
    }
  }
}
```

`test_model_switch` reads provider keys from the environment the server runs in: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`. Add the ones you use to the `env` block (or your shell profile). The other tools need no keys.

## Try it

Ask your assistant things like:

- "Are any AI models in this repo retiring?"
- "What should I switch gpt-4o-2024-08-06 to, and when does it stop working?"
- "Show me what would change to move from claude-3-5-sonnet-20241022 to claude-sonnet-5-5."
- "Test that switch on tests/golden.jsonl with 2 runs."

To inspect the server directly: `npx @modelcontextprotocol/inspector node packages/mcp/dist/main.js`.
