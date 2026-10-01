#!/usr/bin/env node
// Stdio MCP adapter for the running SysMon app.
//
// MCP clients that only speak stdio (most desktop clients) launch this as
// their server command; it bridges stdio (newline-delimited JSON-RPC, via the
// official SDK) to the app's Streamable HTTP endpoint. The bearer token is
// read from the app's protected userData token file at startup, so no secret
// is ever embedded in client configuration files. Run it as the same OS user
// on the machine where SysMon runs (or set SYSMON_MCP_URL to the LAN
// endpoint — the token file is still read locally).
//
// Installed apps run this through the packaged binary so the official SDK
// (inside app.asar) is available to a bare process:
//   SysMon.exe --mcp-stdio            (Windows installed app)
//   SysMon --mcp-stdio                (macOS/Linux installed app)
// The dispatch lives at the top of app/main.cjs, before single-instance,
// window, and monitor startup, so the adapter never launches a second GUI
// or the provider pollers. Dev checkouts can also run `node app/mcp/stdio.cjs`.
//
// Environment overrides: SYSMON_MCP_URL, SYSMON_MCP_TOKEN_FILE, SYSMON_USERDATA.
// stdout carries MCP protocol messages only; diagnostics go to stderr and
// never include the token.
'use strict';
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { defaultTokenFile, readToken } = require('./token.cjs');
const { VERSION } = require('./registry.cjs');
const { MCP_PATH } = require('./server.cjs');

const DEFAULT_URL = `http://127.0.0.1:7738${MCP_PATH}`;

async function main() {
  const url = new URL(process.env.SYSMON_MCP_URL || DEFAULT_URL);
  const token = readToken(defaultTokenFile());

  const client = new Client({ name: 'sysmon-stdio-adapter', version: VERSION });
  const httpTransport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(httpTransport);

  const server = new Server(
    { name: 'sysmon', version: VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );
  // Read-only pass-through: the app enforces auth; this adapter adds nothing.
  server.setRequestHandler(ListToolsRequestSchema, (req) => client.listTools(req.params));
  server.setRequestHandler(CallToolRequestSchema, (req) => client.callTool(req.params));
  server.setRequestHandler(ListResourcesRequestSchema, (req) => client.listResources(req.params));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, (req) => client.listResourceTemplates(req.params));
  server.setRequestHandler(ReadResourceRequestSchema, (req) => client.readResource(req.params));

  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  console.error(`SysMon MCP stdio adapter connected to ${url.origin}${url.pathname}`);

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    Promise.allSettled([server.close(), client.close()]).finally(() => process.exit(0));
  };
  stdio.onclose = shutdown;
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { main };

// Run only when executed directly; app/main.cjs dispatches --mcp-stdio here.
if (require.main === module) {
  main().catch((e) => {
    // Sanitized: e.message from our code/transport contains no token.
    console.error(`SysMon MCP stdio adapter failed: ${e.message}`);
    process.exit(1);
  });
}
