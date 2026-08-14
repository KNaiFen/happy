import pino from 'pino';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createFastifyServer } from './api';

describe('Fastify operational logging', () => {
    it('does not automatically serialize hostile request or error payloads', async () => {
        const hostile = 'prompt-reasoning-tool-output-fastify-request';
        const lines: string[] = [];
        const destination = new Writable({
            write(chunk, _encoding, callback) {
                lines.push(chunk.toString());
                callback();
            },
        });
        const app = createFastifyServer(pino({ level: 'debug' }, destination));
        app.post('/hostile/:id', async () => {
            throw new Error(hostile);
        });
        try {
            await app.inject({
                method: 'POST',
                url: `/hostile/${hostile}?token=${hostile}`,
                headers: { authorization: `Bearer ${hostile}` },
                payload: { value: hostile },
            });

            expect(lines.join('')).not.toContain(hostile);
        } finally {
            await app.close();
        }
    });
});
