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
        const statusCode = isSyncV4Request
            ? safeSyncV4StatusCode(error, reply.statusCode)
            : safeStatusCode(error, reply.statusCode);

        if (!isSyncV4Request) {
            const errorCode = safeErrorCode(error);
            log({
                module: 'fastify-error',
                level: 'error',
                method: request.method,
                route: request.routeOptions?.url || 'unmatched',
                statusCode,
                errorKind: classifyError(errorCode, statusCode),
                ...(errorCode ? { errorCode } : {}),
            }, 'Request failed');
        }

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
                error: safeErrorName(error),
                message: safeClientErrorMessage(error),
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

}

function safeSyncV4StatusCode(error: unknown, replyStatus: number): number {
    return safeStatusCode(error, replyStatus);
}

function safeStatusCode(error: unknown, replyStatus: number): number {
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

function safeErrorCode(error: unknown): string | undefined {
    try {
        const code = error && (typeof error === 'object' || typeof error === 'function')
            ? (error as { code?: unknown }).code
            : undefined;
        if (
            typeof code === 'string'
            && (/^P\d{4}$/.test(code) || /^FST_ERR_[A-Z0-9_]{1,64}$/.test(code))
        ) {
            return code;
        }
    } catch {
        // External errors may expose hostile property getters.
    }
    return undefined;
}

function classifyError(
    errorCode: string | undefined,
    statusCode: number,
): 'prisma' | 'validation' | 'http' | 'unknown' {
    if (errorCode?.startsWith('P')) return 'prisma';
    if (errorCode?.startsWith('FST_ERR_')) return 'validation';
    if (statusCode >= 400 && statusCode < 500) return 'http';
    return 'unknown';
}

function safeErrorName(error: unknown): string {
    try {
        const name = error && (typeof error === 'object' || typeof error === 'function')
            ? (error as { name?: unknown }).name
            : undefined;
        if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name)) {
            return name;
        }
    } catch {
        // Fall through to the fixed client-facing name.
    }
    return 'Error';
}

function safeClientErrorMessage(error: unknown): string {
    try {
        const message = error && (typeof error === 'object' || typeof error === 'function')
            ? (error as { message?: unknown }).message
            : undefined;
        if (typeof message === 'string' && message.length <= 512) {
            return message;
        }
    } catch {
        // Fall through to the fixed client-facing message.
    }
    return 'An error occurred';
}
