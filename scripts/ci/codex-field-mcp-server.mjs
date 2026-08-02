#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const fieldMarker = 'MCP single-card field verification';

const server = new McpServer({
    name: 'Codex field E2E MCP',
    version: '1.0.0',
});

server.registerTool('record_field_event', {
    description: 'Record the deterministic field verification marker.',
    inputSchema: {
        marker: z.literal(fieldMarker),
    },
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async () => ({
    content: [{
        type: 'text',
        text: fieldMarker,
    }],
}));

await server.connect(new StdioServerTransport());
