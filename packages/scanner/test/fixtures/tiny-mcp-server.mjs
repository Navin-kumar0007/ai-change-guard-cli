// A minimal stdio MCP server for the MCP Tool Change Guard tests: one tool whose description comes from
// TOOL_DESC, so a test can change it between two listings.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

serveStdio(() => {
  const server = new McpServer({ name: "tiny", version: "1.0.0" });
  server.registerTool("echo", { description: process.env.TOOL_DESC ?? "Echoes text." }, async () => ({ content: [{ type: "text", text: "ok" }] }));
  return server;
});
