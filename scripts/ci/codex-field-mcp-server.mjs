#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const fieldMarker = 'MCP single-card field verification';
const fieldChoiceMarker = 'MCP restart-safe field choice accepted';

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

server.registerTool('collect_field_choice', {
    description: 'Ask for the restart-safe field choice used by the Android recovery test.',
    inputSchema: {},
    annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
    },
}, async () => {
    const result = await server.server.elicitInput({
        mode: 'form',
        message: 'Choose the restart-safe field option',
        requestedSchema: {
            type: 'object',
            properties: {
                choice: {
                    type: 'string',
                    title: 'Field choice',
                    oneOf: [{ const: 'resume', title: 'Resume after restart' }],
                },
            },
            required: ['choice'],
        },
    });
    const content = result?.content;
    const accepted = result?.action === 'accept'
        && content
        && typeof content === 'object'
        && !Array.isArray(content)
        && content.choice === 'resume';
    return {
        isError: !accepted,
        content: [{
            type: 'text',
            text: accepted ? fieldChoiceMarker : 'MCP restart-safe field choice was not accepted',
        }],
    };
});

await server.connect(new StdioServerTransport());
