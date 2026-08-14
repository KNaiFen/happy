import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { sessionCacheCounter, databaseUpdatesSkippedCounter } from "@/app/monitoring/metrics2";
import { diagnosticHash } from "@/utils/diagnosticHash";
import { inTx } from "@/storage/inTx";
import { acquireAccountWrite } from "@/app/account/accountWriteGate";

interface SessionCacheEntry {
    validUntil: number;
    lastUpdateSent: number;
    pendingUpdate: number | null;
    userId: string;
}

interface MachineCacheEntry {
    validUntil: number;
    lastUpdateSent: number;
    pendingUpdate: number | null;
    userId: string;
    active: boolean;
}

class ActivityCache {
    private sessionCache = new Map<string, SessionCacheEntry>();
    private machineCache = new Map<string, MachineCacheEntry>();
    private batchTimer: ReturnType<typeof setInterval> | null = null;
    
    // Cache TTL (30 seconds)
    private readonly CACHE_TTL = 30 * 1000;
    
    // Only update DB if time difference is significant (30 seconds)
    private readonly UPDATE_THRESHOLD = 30 * 1000;
    
    // Batch update interval (5 seconds)
    private readonly BATCH_INTERVAL = 5 * 1000;

    constructor() {
        this.startBatchTimer();
    }

    private startBatchTimer(): void {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
        }
        
        this.batchTimer = setInterval(() => {
            this.flushPendingUpdates().catch(() => {
                log({ module: 'session-cache', level: 'error' }, 'Error flushing updates');
            });
        }, this.BATCH_INTERVAL);
    }

    async isSessionValid(sessionId: string, userId: string): Promise<boolean> {
        const now = Date.now();
        const cached = this.sessionCache.get(sessionId);
        
        // Check cache first
        if (cached && cached.validUntil > now && cached.userId === userId) {
            sessionCacheCounter.inc({ operation: 'session_validation', result: 'hit' });
            return true;
        }
        
        sessionCacheCounter.inc({ operation: 'session_validation', result: 'miss' });
        
        // Cache miss - check database
        try {
            const session = await db.session.findFirst({
                where: {
                    id: sessionId,
                    accountId: userId,
                    archivedAt: null,
                    account: { is: { deletionRequestedAt: null } },
                }
            });
            
            if (session) {
                // Cache the result
                this.sessionCache.set(sessionId, {
                    validUntil: now + this.CACHE_TTL,
                    lastUpdateSent: session.lastActiveAt.getTime(),
                    pendingUpdate: null,
                    userId
                });
                return true;
            }
            
            return false;
        } catch {
            log({
                module: 'session-cache',
                level: 'error',
                sessionHash: diagnosticHash(sessionId),
            }, 'Error validating session');
            return false;
        }
    }

    async isMachineValid(machineId: string, userId: string): Promise<boolean> {
        const now = Date.now();
        const cached = this.machineCache.get(machineId);
        
        // Check cache first
        if (cached && cached.validUntil > now && cached.userId === userId) {
            sessionCacheCounter.inc({ operation: 'machine_validation', result: 'hit' });
            return true;
        }
        
        sessionCacheCounter.inc({ operation: 'machine_validation', result: 'miss' });
        
        // Cache miss - check database
        try {
            const machine = await db.machine.findFirst({
                where: {
                    accountId: userId,
                    id: machineId,
                    deletedAt: null,
                    account: { is: { deletionRequestedAt: null } },
                },
            });
            
            if (machine) {
                // Cache the result
                this.machineCache.set(machineId, {
                    validUntil: now + this.CACHE_TTL,
                    lastUpdateSent: machine.lastActiveAt?.getTime() || 0,
                    pendingUpdate: null,
                    userId,
                    active: machine.active
                });
                return true;
            }
            
            return false;
        } catch {
            log({
                module: 'session-cache',
                level: 'error',
                machineHash: diagnosticHash(machineId),
            }, 'Error validating machine');
            return false;
        }
    }

    queueSessionUpdate(sessionId: string, timestamp: number): boolean {
        const cached = this.sessionCache.get(sessionId);
        if (!cached) {
            return false; // Should validate first
        }
        
        // Only queue if time difference is significant
        const timeDiff = Math.abs(timestamp - cached.lastUpdateSent);
        if (timeDiff > this.UPDATE_THRESHOLD) {
            cached.pendingUpdate = timestamp;
            return true;
        }
        
        databaseUpdatesSkippedCounter.inc({ type: 'session' });
        return false; // No update needed
    }

    queueMachineUpdate(machineId: string, timestamp: number): boolean {
        const cached = this.machineCache.get(machineId);
        if (!cached) {
            return false; // Should validate first
        }
        
        // Always persist a heartbeat that flips an inactive machine online.
        // New machines start inactive with lastActiveAt defaulting to "now", so
        // the timestamp threshold alone would skip the first onboarding ping.
        const timeDiff = Math.abs(timestamp - cached.lastUpdateSent);
        if (!cached.active || timeDiff > this.UPDATE_THRESHOLD) {
            cached.pendingUpdate = timestamp;
            return true;
        }
        
        databaseUpdatesSkippedCounter.inc({ type: 'machine' });
        return false; // No update needed
    }

    invalidateMachine(machineId: string): void {
        this.machineCache.delete(machineId);
    }

    invalidateSessions(sessionIds: readonly string[]): void {
        for (const sessionId of sessionIds) {
            this.sessionCache.delete(sessionId);
        }
    }

    invalidateUser(userId: string): void {
        for (const [sessionId, entry] of this.sessionCache.entries()) {
            if (entry.userId === userId) {
                this.sessionCache.delete(sessionId);
            }
        }
        for (const [machineId, entry] of this.machineCache.entries()) {
            if (entry.userId === userId) {
                this.machineCache.delete(machineId);
            }
        }
    }

    private async flushPendingUpdates(): Promise<void> {
        const sessionUpdates: { id: string, timestamp: number, userId: string }[] = [];
        const machineUpdates: { id: string, timestamp: number, userId: string }[] = [];
        
        // Collect session updates
        for (const [sessionId, entry] of this.sessionCache.entries()) {
            if (entry.pendingUpdate) {
                sessionUpdates.push({ id: sessionId, timestamp: entry.pendingUpdate, userId: entry.userId });
                entry.lastUpdateSent = entry.pendingUpdate;
                entry.pendingUpdate = null;
            }
        }
        
        // Collect machine updates
        for (const [machineId, entry] of this.machineCache.entries()) {
            if (entry.pendingUpdate) {
                machineUpdates.push({ 
                    id: machineId, 
                    timestamp: entry.pendingUpdate, 
                    userId: entry.userId 
                });
                entry.lastUpdateSent = entry.pendingUpdate;
                entry.active = true;
                entry.pendingUpdate = null;
            }
        }
        
        const userIds = new Set([
            ...sessionUpdates.map((update) => update.userId),
            ...machineUpdates.map((update) => update.userId),
        ]);

        await Promise.all([...userIds].map(async (userId) => {
            try {
                await inTx(async (tx) => {
                    if (!await acquireAccountWrite(tx, userId)) return;

                    for (const update of sessionUpdates) {
                        if (update.userId !== userId) continue;
                        await tx.session.updateMany({
                            where: {
                                id: update.id,
                                accountId: userId,
                                account: { deletionRequestedAt: null },
                                active: true,
                                archivedAt: null,
                                presenceLeaseId: null,
                                OR: [
                                    { originMachineId: null },
                                    { originMachine: { deletedAt: null } },
                                ],
                            },
                            data: { lastActiveAt: new Date(update.timestamp), active: true }
                        });
                    }

                    for (const update of machineUpdates) {
                        if (update.userId !== userId) continue;
                        await tx.machine.updateMany({
                            where: {
                                accountId: userId,
                                account: { deletionRequestedAt: null },
                                id: update.id,
                                deletedAt: null,
                            },
                            data: { lastActiveAt: new Date(update.timestamp), active: true }
                        });
                    }
                });
            } catch {
                log({ module: 'session-cache', level: 'error' }, 'Error updating presence');
            }
        }));

        if (sessionUpdates.length > 0) {
            log({ module: 'session-cache' }, `Flushed ${sessionUpdates.length} session updates`);
        }
        if (machineUpdates.length > 0) {
            log({ module: 'session-cache' }, `Flushed ${machineUpdates.length} machine updates`);
        }
    }

    // Cleanup old cache entries periodically
    cleanup(): void {
        const now = Date.now();
        
        for (const [sessionId, entry] of this.sessionCache.entries()) {
            if (entry.validUntil < now) {
                this.sessionCache.delete(sessionId);
            }
        }
        
        for (const [machineId, entry] of this.machineCache.entries()) {
            if (entry.validUntil < now) {
                this.machineCache.delete(machineId);
            }
        }
    }

    shutdown(): void {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
            this.batchTimer = null;
        }
        
        // Flush any remaining updates
        this.flushPendingUpdates().catch(() => {
            log({ module: 'session-cache', level: 'error' }, 'Error flushing final updates');
        });
    }
}

// Global instance
export const activityCache = new ActivityCache();

// Cleanup every 5 minutes
setInterval(() => {
    activityCache.cleanup();
}, 5 * 60 * 1000);
