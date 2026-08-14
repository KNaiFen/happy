import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Fastify } from '../types';

const { fileLogger } = vi.hoisted(() => ({
    fileLogger: {
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
    },
}));

vi.mock('@/utils/log', () => ({ fileConsolidatedLogger: fileLogger }));

import { devRoutes } from './devRoutes';

describe('remote debug payload-free logging', () => {
    let app: Fastify | undefined;
    const previousFlag = process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING;

    beforeEach(async () => {
        vi.clearAllMocks();
        process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING = '1';
        const base = fastify();
        base.setValidatorCompiler(validatorCompiler);
        base.setSerializerCompiler(serializerCompiler);
        app = base.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
        devRoutes(app);
        await app.ready();
    });

    afterEach(async () => {
        await app?.close();
        app = undefined;
        if (previousFlag === undefined) {
            delete process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING;
        } else {
            process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING = previousFlag;
        }
    });

    it('records only fixed source and severity fields', async () => {
        const hostile = 'prompt-reasoning-tool-output-remote-debug';
        const response = await app!.inject({
            method: 'POST',
            url: '/logs-combined-from-cli-and-mobile-for-simple-ai-debugging',
            payload: {
                timestamp: hostile,
                level: 'warning',
                message: hostile,
                messageRawObject: { nested: hostile },
                source: 'cli',
                platform: hostile,
            },
        });

        expect(response.statusCode).toBe(200);
        expect(fileLogger.warn).toHaveBeenCalledWith({
            module: 'remote-debug',
            source: 'cli',
            severity: 'warn',
        }, 'Remote debug event received');
        expect(JSON.stringify(Object.values(fileLogger).flatMap((mock) => mock.mock.calls))).not.toContain(hostile);
    });
});
