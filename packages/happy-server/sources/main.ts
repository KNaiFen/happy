import { startApi } from "@/app/api/api";
import { log } from "@/utils/log";
import { awaitShutdown, onShutdown } from "@/utils/shutdown";
import { db } from './storage/db';
import { startTimeout } from "./app/presence/timeout";
import { startMetricsServer } from "@/app/monitoring/metrics";
import { activityCache } from "@/app/presence/sessionCache";
import { auth } from "./app/auth/auth";
import { startDatabaseMetricsUpdater } from "@/app/monitoring/metrics2";
import { initEncrypt } from "./modules/encrypt";
import { initGithub } from "./modules/github";
import { loadFiles } from "./storage/files";
import { purgeUnsupportedSessions } from "./app/session/purgeUnsupportedSessions";
import { startAccountDeletionProcessor } from "./app/account/accountDeletion";

async function main() {

    // Storage
    await db.$connect();
    onShutdown('db', async () => {
        await db.$disconnect();
    });
    onShutdown('activity-cache', async () => {
        activityCache.shutdown();
    });
    if (process.env.REDIS_URL) {
        const { Redis } = await import('ioredis');
        const redis = new Redis(process.env.REDIS_URL);
        await redis.ping();
    }

    // Initialize auth module
    await initEncrypt();
    await initGithub();
    await loadFiles();
    await purgeUnsupportedSessions();
    await auth.init();

    //
    // Start
    //

    await startApi();
    startAccountDeletionProcessor();
    await startMetricsServer();
    startDatabaseMetricsUpdater();
    startTimeout();

    //
    // Ready
    //

    log('Ready');
    await awaitShutdown();
    log('Shutting down...');
}

// Process-level error handling
process.on('uncaughtException', (error) => {
    log({
        module: 'process-error',
        level: 'error',
        errorKind: error instanceof Error ? 'exception' : 'unknown',
    }, 'Uncaught exception');

    console.error('Uncaught exception');
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    log({
        module: 'process-error',
        level: 'error',
        errorKind: reason instanceof Error ? 'rejection' : 'unknown',
    }, 'Unhandled rejection');

    console.error('Unhandled rejection');
    process.exit(1);
});

process.on('warning', () => {
    log({
        module: 'process-warning',
        level: 'warn',
    }, 'Process warning');
});

// Log when the process is about to exit
process.on('exit', (code) => {
    if (code !== 0) {
        log({
            module: 'process-exit',
            level: 'error',
            exitCode: code
        }, `Process exiting with code: ${code}`);
    } else {
        log({
            module: 'process-exit',
            level: 'info',
            exitCode: code
        }, 'Process exiting normally');
    }
});

main().catch((e) => {
    console.error('Server startup failed');
    process.exit(1);
}).then(() => {
    process.exit(0);
});
