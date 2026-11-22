#!/usr/bin/env node
// stdio entry point. stdout carries the MCP protocol, so anything human-readable goes to stderr.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer, resolveRoot, VERSION } from "./server.js";

// createServer resolves the same root itself (and refuses "/" or the home folder unless ACG_ROOT is set).
serveStdio(() => createServer());
console.error(`ai-change-guard MCP server ${VERSION} ready on stdio (project: ${resolveRoot()})`);
