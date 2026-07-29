import { log } from "@/utils/log";
import { Fastify } from "../types";
import { FastifyError } from "fastify";

export interface EnableErrorHandlersOptions {
    skipNotFoundHandler?: boolean;
}

export function enableErrorHandlers(app: Fastify, options: EnableErrorHandlersOptions = {}) {
    // Global error handler
    app.setErrorHandler(async (error: FastifyError, request, reply) => {
        const isSyncV4Request = typeof request.syncV4TraceId === 'string';
        const method = request.method;
        const url = request.url;
        const userAgent = request.headers['user-agent'] || 'unknown';
        const ip = request.ip || 'unknown';

        // Log the error with comprehensive context
        if (!isSyncV4Request) {
            log({
                module: 'fastify-error',
                level: 'error',
                method,
                url,
                userAgent,
                ip,
                statusCode: error.statusCode || 500,
                errorCode: error.code,
                stack: error.stack
            }, `Unhandled error: ${error.message}`);
        }

        // Return appropriate error response
        const statusCode = isSyncV4Request
            ? safeSyncV4StatusCode(error, reply.statusCode)
            : error.statusCode || 500;

        if (isSyncV4Request) {
            return reply.code(statusCode).send({
                error: statusCode >= 500 ? 'Internal Server Error' : 'Invalid Sync v4 request',
                statusCode
            });
        } else if (statusCode >= 500) {
            // Internal server errors - don't expose details
            return reply.code(statusCode).send({
                error: 'Internal Server Error',
                message: 'An unexpected error occurred',
                statusCode
            });
        } else {
            // Client errors - can expose more details
            return reply.code(statusCode).send({
                error: error.name || 'Error',
                message: error.message || 'An error occurred',
                statusCode
            });
        }
    });

    // Catch-all route for debugging 404s. Skipped when caller will register
    // its own (e.g. SPA fallback for self-hosted webapp).
    if (!options.skipNotFoundHandler) {
        app.setNotFoundHandler((request, reply) => {
            log({
                module: '404-handler',
                method: request.method,
                pathLength: request.url.length,
                hasQuery: request.url.includes('?'),
            }, 'Route not found');
            reply.code(404).send({ error: 'Not found', path: request.url, method: request.method });
        });
    }

    // Error hook for additional logging
    app.addHook('onError', async (request, reply, error) => {
        if (typeof request.syncV4TraceId === 'string') return;
        const method = request.method;
        const url = request.url;
        const duration = (Date.now() - (request.startTime || Date.now())) / 1000;

        log({
            module: 'fastify-hook-error',
            level: 'error',
            method,
            url,
            duration,
            statusCode: reply.statusCode || error.statusCode || 500,
            errorName: error.name,
            errorCode: error.code
        }, `Request error: ${error.message}`);
    });

    // Handle uncaught exceptions in routes
    app.addHook('preHandler', async (request, reply) => {
        // Store original reply.send to catch errors in response serialization
        const originalSend = reply.send.bind(reply);
        reply.send = function (payload: any) {
            try {
                return originalSend(payload);
            } catch (error: any) {
                if (typeof request.syncV4TraceId !== 'string') {
                    log({
                        module: 'fastify-serialization-error',
                        level: 'error',
                        method: request.method,
                        url: request.url,
                        stack: error.stack
                    }, `Response serialization error: ${error.message}`);
                }
                throw error;
            }
        };
    });
}

function safeSyncV4StatusCode(error: unknown, replyStatus: number): number {
    try {
        const statusCode = error && (typeof error === 'object' || typeof error === 'function')
            ? (error as { statusCode?: unknown }).statusCode
            : undefined;
        if (typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 599) {
            return statusCode;
        }
    } catch {
        // Fall through to the already-sanitized reply status or a fixed 500.
    }
    return replyStatus >= 400 && replyStatus <= 599 ? replyStatus : 500;
}
