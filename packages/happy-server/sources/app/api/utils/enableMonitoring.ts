import { db } from "@/storage/db";
import { Fastify } from "../types";
import { httpRequestsCounter, httpRequestDurationHistogram, getMetricsLabelsFromRequest } from "@/app/monitoring/metrics2";
import { log } from "@/utils/log";

export function enableMonitoring(app: Fastify) {
    // Add metrics hooks
    app.addHook('onRequest', async (request, reply) => {
        request.startTime = Date.now();
    });

    app.addHook('onResponse', async (request, reply) => {
        const duration = (Date.now() - (request.startTime || Date.now())) / 1000;
        const method = request.method;
        // Use routeOptions.url for the route template, fallback to parsed URL path
        const route = request.routeOptions?.url || request.url.split('?')[0] || 'unknown';
        const status = reply.statusCode.toString();
        const labels = getMetricsLabelsFromRequest(request);

        // Increment request counter
        httpRequestsCounter.inc({ method, route, status, ...labels });

        // Record request duration
        httpRequestDurationHistogram.observe({ method, route, status, ...labels }, duration);
    });

    app.get('/health', async (request, reply) => {
        try {
            const rows = await db.$queryRaw<Array<{ byteaProbe: Uint8Array }>>`
                SELECT decode('0001feff', 'hex') AS "byteaProbe"
            `;
            const probe = rows[0]?.byteaProbe;
            if (
                !(probe instanceof Uint8Array)
                || probe.length !== 4
                || probe[0] !== 0
                || probe[1] !== 1
                || probe[2] !== 254
                || probe[3] !== 255
            ) {
                throw new Error("Invalid database BYTEA probe");
            }
            reply.send({
                status: 'ok',
                timestamp: new Date().toISOString(),
                service: 'happy-server'
            });
        } catch {
            log(
                { module: 'health', level: 'error', errorKind: 'database' },
                'Database health check failed',
            );
            reply.code(503).send({
                status: 'error',
                timestamp: new Date().toISOString(),
                service: 'happy-server',
                error: 'Database health check failed'
            });
        }
    });
}
