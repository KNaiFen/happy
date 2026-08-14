import { Tx } from "@/storage/inTx";
import * as privacyKit from "privacy-kit";

export interface KVBulkGetResult {
    values: Array<{
        key: string;
        value: string;
        version: number;
    }>;
}

/**
 * Get multiple key-value pairs for the authenticated user.
 * Only returns existing keys with non-null values; missing or deleted keys are omitted.
 */
export async function kvBulkGet(
    tx: Pick<Tx, 'userKVStore'>,
    ctx: { uid: string },
    keys: string[]
): Promise<KVBulkGetResult> {
    const results = await tx.userKVStore.findMany({
        where: {
            accountId: ctx.uid,
            key: {
                in: keys
            },
            value: {
                not: null  // Exclude deleted entries
            }
        }
    });

    return {
        values: results
            .filter(r => r.value !== null)  // Extra safety check
            .map(r => ({
                key: r.key,
                value: privacyKit.encodeBase64(r.value!),
                version: r.version
            }))
    };
}
