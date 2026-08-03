import { db } from '@/storage/db';
import { deleteSessionAttachments } from '@/storage/files';
import { inTx } from '@/storage/inTx';
import { log } from '@/utils/log';
import { PRESERVED_SESSION_TAG_PREFIXES } from './supportedSessionTags';

export { PRESERVED_SESSION_TAG_PREFIXES } from './supportedSessionTags';

const DEFAULT_BATCH_SIZE = 100;

type PurgeCandidate = { id: string };

export interface UnsupportedSessionPurgeDependencies {
    listBatch: (limit: number) => Promise<PurgeCandidate[]>;
    deleteAttachments: (sessionId: string) => Promise<void>;
    deleteRecord: (sessionId: string) => Promise<boolean>;
}

function unsupportedSessionWhere() {
    return {
        AND: PRESERVED_SESSION_TAG_PREFIXES.map((prefix) => ({
            NOT: { tag: { startsWith: prefix } },
        })),
    };
}

const defaultDependencies: UnsupportedSessionPurgeDependencies = {
    listBatch: async (limit) => db.session.findMany({
        where: unsupportedSessionWhere(),
        orderBy: { id: 'asc' },
        take: limit,
        select: { id: true },
    }),
    deleteAttachments: deleteSessionAttachments,
    deleteRecord: async (sessionId) => inTx(async (tx) => {
        const current = await tx.session.findFirst({
            where: { id: sessionId, ...unsupportedSessionWhere() },
            select: { id: true },
        });
        if (!current) return false;

        await tx.sessionMessage.deleteMany({ where: { sessionId } });
        await tx.usageReport.deleteMany({ where: { sessionId } });
        await tx.accessKey.deleteMany({ where: { sessionId } });
        await tx.session.delete({ where: { id: sessionId } });
        return true;
    }),
};

export async function purgeUnsupportedSessions(
    dependencies: UnsupportedSessionPurgeDependencies = defaultDependencies,
    batchSize = DEFAULT_BATCH_SIZE,
): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
        throw new Error('Unsupported-session purge batch size must be a positive integer');
    }

    let deletedCount = 0;
    while (true) {
        const candidates = await dependencies.listBatch(batchSize);
        if (candidates.length === 0) break;

        let progressed = false;
        for (const candidate of candidates) {
            await dependencies.deleteAttachments(candidate.id);
            if (await dependencies.deleteRecord(candidate.id)) {
                deletedCount += 1;
                progressed = true;
            }
        }

        if (!progressed) break;
    }

    log({
        module: 'session-v4-only-purge',
        deletedCount,
    }, 'Unsupported sessions purged');
    return deletedCount;
}
