import * as privacyKit from "privacy-kit";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { diagnosticHash } from "@/utils/diagnosticHash";
import { inTx } from "@/storage/inTx";
import { acquireAccountWrite } from "@/app/account/accountWriteGate";

/** Cache entries expire after 24 hours */
const TOKEN_CACHE_TTL = 24 * 60 * 60 * 1000;
/** Hard cap to prevent unbounded growth */
const MAX_CACHE_SIZE = 10_000;
/** Run cleanup every 10 minutes */
const CLEANUP_INTERVAL = 10 * 60 * 1000;
export const GITHUB_OAUTH_STATE_TTL_MS = 5 * 60 * 1000;

interface TokenCacheEntry {
    userId: string;
    extras?: Record<string, unknown>;
    credentialId?: string;
    cachedAt: number;
}

export interface VerifiedAuthToken {
    userId: string;
    extras?: Record<string, unknown>;
    credentialId?: string;
    machineId?: string;
}

interface AuthTokens {
    generator: Awaited<ReturnType<typeof privacyKit.createPersistentTokenGenerator>>;
    verifier: Awaited<ReturnType<typeof privacyKit.createPersistentTokenVerifier>>;
    githubVerifier: Awaited<ReturnType<typeof privacyKit.createEphemeralTokenVerifier>>;
    githubGenerator: Awaited<ReturnType<typeof privacyKit.createEphemeralTokenGenerator>>;
}

interface ActiveTerminalCredential {
    machineId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null
        ? value as Record<string, unknown>
        : undefined;
}

export function terminalCredentialIdFromExtras(extras: unknown): string | undefined {
    const record = asRecord(extras);
    if (!record) return undefined;
    if (typeof record.credentialId === "string" && record.credentialId.length > 0) {
        return record.credentialId;
    }
    return typeof record.session === "string" && record.session.length > 0
        ? record.session
        : undefined;
}

export class AuthModule {
    private tokenCache = new Map<string, TokenCacheEntry>();
    private tokens: AuthTokens | null = null;
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

    async init(): Promise<void> {
        if (this.tokens) {
            return; // Already initialized
        }

        log({ module: 'auth' }, 'Initializing auth module...');

        const generator = await privacyKit.createPersistentTokenGenerator({
            service: 'handy',
            seed: process.env.HANDY_MASTER_SECRET!
        });


        const verifier = await privacyKit.createPersistentTokenVerifier({
            service: 'handy',
            publicKey: Uint8Array.from(generator.publicKey)
        });

        const githubGenerator = await privacyKit.createEphemeralTokenGenerator({
            service: 'github-happy',
            seed: process.env.HANDY_MASTER_SECRET!,
            ttl: GITHUB_OAUTH_STATE_TTL_MS
        });

        const githubVerifier = await privacyKit.createEphemeralTokenVerifier({
            service: 'github-happy',
            publicKey: Uint8Array.from(githubGenerator.publicKey),
        });


        this.tokens = { generator, verifier, githubVerifier, githubGenerator };

        // Start periodic cleanup of expired cache entries
        this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL);

        log({ module: 'auth' }, 'Auth module initialized');
    }
    
    async createToken(userId: string, extras?: Record<string, unknown>): Promise<string | null> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }

        // Keep account admission and token issuance in one serializable
        // transaction so deletion cannot commit between the active check and
        // generation of a credential.
        const token = await inTx(async (tx) => {
            if (!await acquireAccountWrite(tx, userId)) return null;
            const payload: any = { user: userId };
            if (extras) payload.extras = extras;
            return this.tokens!.generator.new(payload);
        });
        if (!token) return null;

        this.tokenCache.set(token, {
            userId,
            extras,
            credentialId: terminalCredentialIdFromExtras(extras),
            cachedAt: Date.now()
        });
        return token;
    }
    
    async verifyToken(token: string): Promise<VerifiedAuthToken | null> {
        // Check cache first (with TTL)
        const cached = this.tokenCache.get(token);
        if (cached) {
            if (Date.now() - cached.cachedAt > TOKEN_CACHE_TTL) {
                this.tokenCache.delete(token);
            } else {
                if (!(await this.loadActiveAccount(cached.userId))) {
                    this.tokenCache.delete(token);
                    return null;
                }
                let machineId: string | undefined;
                if (cached.credentialId) {
                    const credential = await this.loadActiveTerminalCredential(
                        cached.userId,
                        cached.credentialId,
                    );
                    if (!credential) {
                        this.tokenCache.delete(token);
                        return null;
                    }
                    machineId = credential.machineId;
                }
                return {
                    userId: cached.userId,
                    extras: cached.extras,
                    credentialId: cached.credentialId,
                    machineId,
                };
            }
        }
        
        // Cache miss - verify token
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        
        try {
            const verified = await this.tokens.verifier.verify(token);
            if (!verified) {
                return null;
            }
            
            const userId = verified.user as string;
            if (typeof userId !== 'string' || !(await this.loadActiveAccount(userId))) {
                return null;
            }
            const extras = asRecord(verified.extras);
            const credentialId = terminalCredentialIdFromExtras(extras);
            let machineId: string | undefined;
            if (credentialId) {
                const credential = await this.loadActiveTerminalCredential(
                    userId,
                    credentialId,
                );
                if (!credential) return null;
                machineId = credential.machineId;
            }
            
            // Evict oldest entries if cache is at capacity
            if (this.tokenCache.size >= MAX_CACHE_SIZE) {
                const oldest = [...this.tokenCache.entries()]
                    .sort((a, b) => a[1].cachedAt - b[1].cachedAt)
                    .slice(0, Math.floor(MAX_CACHE_SIZE * 0.2));
                for (const [key] of oldest) {
                    this.tokenCache.delete(key);
                }
            }

            this.tokenCache.set(token, {
                userId,
                extras,
                credentialId,
                cachedAt: Date.now()
            });
            
            return { userId, extras, credentialId, machineId };
            
        } catch {
            log({ module: 'auth', level: 'error' }, 'Token verification failed');
            return null;
        }
    }

    private async loadActiveTerminalCredential(
        userId: string,
        credentialId: string,
    ): Promise<ActiveTerminalCredential | null> {
        try {
            const credential = await db.terminalAuthRequest.findUnique({
                where: { id: credentialId },
                select: {
                    responseAccountId: true,
                    response: true,
                    revokedAt: true,
                    machine: {
                        select: {
                            id: true,
                            accountId: true,
                            deletedAt: true,
                        },
                    },
                },
            });
            if (
                credential?.responseAccountId !== userId
                || credential.response === null
                || credential.revokedAt !== null
            ) {
                return null;
            }
            if (
                credential.machine
                && (
                    credential.machine.accountId !== userId
                    || credential.machine.deletedAt !== null
                )
            ) {
                return null;
            }
            return { machineId: credential.machine?.id };
        } catch {
            log({
                module: 'auth',
                level: 'error',
            }, 'Terminal credential validation failed');
            return null;
        }
    }

    private async loadActiveAccount(userId: string): Promise<boolean> {
        try {
            const account = await db.account.findUnique({
                where: { id: userId },
                select: { deletionRequestedAt: true },
            });
            return account?.deletionRequestedAt === null;
        } catch {
            log({
                module: 'auth',
                level: 'error',
            }, 'Account validation failed');
            return false;
        }
    }

    async isAccountActive(userId: string): Promise<boolean> {
        return this.loadActiveAccount(userId);
    }
    
    invalidateUserTokens(userId: string): void {
        // Remove all tokens for a specific user
        // This is expensive but rarely needed
        for (const [token, entry] of this.tokenCache.entries()) {
            if (entry.userId === userId) {
                this.tokenCache.delete(token);
            }
        }
        
        log({
            module: 'auth',
            userHash: diagnosticHash(userId),
        }, 'Invalidated user tokens');
    }

    invalidateCredentialTokens(credentialId: string): void {
        for (const [token, entry] of this.tokenCache.entries()) {
            if (entry.credentialId === credentialId) {
                this.tokenCache.delete(token);
            }
        }
        log({ module: 'auth' }, 'Invalidated terminal credential tokens');
    }
    
    invalidateToken(token: string): void {
        this.tokenCache.delete(token);
    }
    
    getCacheStats(): { size: number; oldestEntry: number | null } {
        if (this.tokenCache.size === 0) {
            return { size: 0, oldestEntry: null };
        }
        
        let oldest = Date.now();
        for (const entry of this.tokenCache.values()) {
            if (entry.cachedAt < oldest) {
                oldest = entry.cachedAt;
            }
        }
        
        return {
            size: this.tokenCache.size,
            oldestEntry: oldest
        };
    }
    
    async createGithubToken(userId: string, admissionId: string): Promise<string> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        
        const payload = {
            user: userId,
            extras: { purpose: 'github-oauth', admissionId },
        };
        const token = await this.tokens.githubGenerator.new(payload);
        
        return token;
    }

    async verifyGithubToken(token: string): Promise<{ userId: string; admissionId: string } | null> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        
        try {
            const verified = await this.tokens.githubVerifier.verify(token);
            if (!verified) {
                return null;
            }
            
            const userId = verified.user;
            const extras = asRecord(verified.extras);
            const admissionId = extras?.admissionId;
            if (
                extras?.purpose !== 'github-oauth'
                || typeof userId !== 'string'
                || userId.length === 0
                || typeof admissionId !== 'string'
                || admissionId.length === 0
                || !(await this.loadActiveAccount(userId))
            ) {
                return null;
            }
            return { userId, admissionId };
        } catch {
            log({ module: 'auth', level: 'error' }, 'GitHub token verification failed');
            return null;
        }
    }

    /** Remove expired entries from the cache */
    cleanup(): void {
        const now = Date.now();
        let removed = 0;
        for (const [token, entry] of this.tokenCache.entries()) {
            if (now - entry.cachedAt > TOKEN_CACHE_TTL) {
                this.tokenCache.delete(token);
                removed++;
            }
        }
        if (removed > 0) {
            log({ module: 'auth' }, `Token cache cleanup: removed ${removed}, remaining ${this.tokenCache.size}`);
        }
    }
}

// Global instance
export const auth = new AuthModule();
