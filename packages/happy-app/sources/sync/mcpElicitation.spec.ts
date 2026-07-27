import { describe, expect, it } from 'vitest';
import {
    initialMcpElicitationValues,
    formatMcpElicitationValue,
    parseMcpElicitation,
    parseMcpElicitationJson,
    parseMcpElicitationResponse,
    serializeMcpElicitationValues,
} from './mcpElicitation';

describe('MCP elicitation projection', () => {
    it('parses typed form fields and serializes provider values', () => {
        const parsed = parseMcpElicitation({
            requestMethod: 'mcpServer/elicitation/request',
            mode: 'form',
            message: 'Configure deployment',
            requestedSchema: {
                type: 'object',
                required: ['region', 'replicas'],
                properties: {
                    region: { type: 'string', title: 'Region', enum: ['us', 'eu'], default: 'eu' },
                    replicas: { type: 'integer', minimum: 1, maximum: 10, default: 2 },
                    dryRun: { type: 'boolean', default: true },
                    tags: {
                        type: 'array',
                        items: { anyOf: [{ const: 'api', title: 'API' }, { const: 'web', title: 'Web' }] },
                        default: ['api'],
                    },
                },
            },
        });
        expect(parsed).toMatchObject({ mode: 'form', fields: [
            { key: 'region', kind: 'single', required: true },
            { key: 'replicas', kind: 'integer', required: true },
            { key: 'dryRun', kind: 'boolean' },
            { key: 'tags', kind: 'multi' },
        ] });
        if (!parsed || parsed.mode !== 'form') throw new Error('expected form');
        expect(serializeMcpElicitationValues(parsed.fields, initialMcpElicitationValues(parsed.fields))).toEqual({
            region: 'eu',
            replicas: 2,
            dryRun: true,
            tags: ['api'],
        });
    });

    it('rejects invalid form values and unsafe URL schemes', () => {
        const parsed = parseMcpElicitation({
            requestMethod: 'mcpServer/elicitation/request',
            mode: 'form',
            requestedSchema: {
                type: 'object',
                required: ['count'],
                properties: { count: { type: 'integer', minimum: 1 } },
            },
        });
        if (!parsed || parsed.mode !== 'form') throw new Error('expected form');
        expect(serializeMcpElicitationValues(parsed.fields, { count: '1.5' })).toBeNull();
        expect(parseMcpElicitation({
            requestMethod: 'mcpServer/elicitation/request',
            mode: 'url',
            url: 'javascript:alert(1)',
        })).toBeNull();
    });

    it('supports arbitrary OpenAI forms through validated JSON objects', () => {
        expect(parseMcpElicitation({
            requestMethod: 'mcpServer/elicitation/request',
            mode: 'openai/form',
            message: 'Provide advanced options',
            requestedSchema: { layout: 'custom' },
        })).toEqual({ mode: 'json', message: 'Provide advanced options', initialJson: '{}' });
        expect(parseMcpElicitationJson('{"enabled":true}')).toEqual({ enabled: true });
        expect(parseMcpElicitationJson('[]')).toBeNull();
    });

    it('restores accepted form and JSON responses', () => {
        expect(parseMcpElicitationResponse({
            action: 'accept',
            content: { region: 'eu', replicas: 2, tags: ['api', 'web'] },
        })).toEqual({
            action: 'accept',
            content: { region: 'eu', replicas: 2, tags: ['api', 'web'] },
        });
        expect(formatMcpElicitationValue(['api', 'web'])).toBe('["api","web"]');
        expect(formatMcpElicitationValue(true)).toBe('true');
    });

    it('restores cancel and URL completion responses without accepting invalid actions', () => {
        expect(parseMcpElicitation({
            requestMethod: 'mcpServer/elicitation/request',
            mode: 'url',
            message: 'Authorize account',
            url: 'https://example.com/authorize',
        })).toEqual({
            mode: 'url',
            message: 'Authorize account',
            url: 'https://example.com/authorize',
        });
        expect(parseMcpElicitationResponse({ action: 'accept', content: null })).toEqual({
            action: 'accept',
            content: null,
        });
        expect(parseMcpElicitationResponse({ action: 'cancel', content: null })).toEqual({
            action: 'cancel',
            content: null,
        });
        expect(parseMcpElicitationResponse({ action: 'unknown', content: null })).toBeNull();
    });
});
