import { z } from 'zod';
import { Fastify } from '../types';

export function devRoutes(app: Fastify) {

    // Combined logging endpoint (only when explicitly enabled)
    if (process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING) {
        app.post('/logs-combined-from-cli-and-mobile-for-simple-ai-debugging', {
            schema: {
                body: z.object({
                    timestamp: z.string(),
                    level: z.string(),
                    message: z.string(),
                    messageRawObject: z.any().optional(),
                    source: z.enum(['mobile', 'cli']),
                    platform: z.string().optional()
                })
            }
        }, async (request, reply) => {
            const { level, source } = request.body;

            // Log ONLY to separate remote logger (file only, no console)
            const logData = {
                module: 'remote-debug',
                source,
                severity: normalizeRemoteSeverity(level),
            };

            // Use the file-only logger if available
            const { fileConsolidatedLogger } = await import('@/utils/log');

            if (!fileConsolidatedLogger) {
                // Should never happen since we check env var above, but be safe
                return reply.send({ success: true });
            }

            switch (logData.severity) {
                case 'error':
                    fileConsolidatedLogger.error(logData, 'Remote debug event received');
                    break;
                case 'warn':
                    fileConsolidatedLogger.warn(logData, 'Remote debug event received');
                    break;
                case 'debug':
                    fileConsolidatedLogger.debug(logData, 'Remote debug event received');
                    break;
                default:
                    fileConsolidatedLogger.info(logData, 'Remote debug event received');
            }

            return reply.send({ success: true });
        });
    }
}

function normalizeRemoteSeverity(level: string): 'error' | 'warn' | 'debug' | 'info' {
    switch (level.toLowerCase()) {
        case 'error': return 'error';
        case 'warn':
        case 'warning': return 'warn';
        case 'debug': return 'debug';
        default: return 'info';
    }
}
