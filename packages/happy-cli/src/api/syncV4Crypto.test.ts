import {
    MAX_CODEX_SYNC_V4_PART_BYTES,
    type CodexEntityV4,
} from "@slopus/happy-wire";
import { decodeBase64, encodeBase64 } from "@/api/encryption";
import { SyncV4Crypto, SyncV4DecryptionError } from "./syncV4Crypto";
import { describe, expect, it, vi } from "vitest";

const sessionKey = Uint8Array.from({ length: 32 }, (_, index) => index);
const nonce = Uint8Array.from({ length: 12 }, (_, index) => 0xa0 + index);
const opaqueEntityId = "FB3k6oMuHXDCahGdf5_8oHMotEe6X9yuRE9QOf72uok";
const encryptedVector = "AaChoqOkpaanqKmqq/4yaqnQnL9rELQvKqBxR11IeGxOGIEfJ8DOfhWrDG+QXayC6Fz4eQR5BGibyuxWnC30ajA/j8fMgQUkaSjP8BJSGXYeqcZ0hPSwV9dmCj/AJ9WnqNDKEM0wzIbR3pt75OpkqBVpjnWifPS+KtyLM3ujXH/EEfnWOM30iLOrwJ4q35CG46nyIuSrsTX9/S3P+gCzzULNGT+f5u3pFSRHly7a5sa+xJ0TV7RTqKLpG+vMnkmMYAsXY+gR2LV7GrtGY9DX451CLC0Fk+z0UgGG+OwyeTVN/t4Z5e1W4Ht84LKO5BqS9K27HtzH2yrFjIVVRCzVoCW5/g96gVE7F/BHyBObyWvjKAM2nc1oKuWpsiS5HY3v/xvM5I1EUd27I5y3Xi/uc3nCxA96FV60mGlcS3TTCnMIzcSYY16HBbL+MOFM6Q==";
const entity = {
    schemaVersion: 1 as const,
    entityType: "codex.part" as const,
    providerId: "part-1",
    createdAt: 10,
    updatedAt: 11,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    partId: "part-1",
    kind: "reasoningSummary" as const,
    index: 0,
    chunkIndex: 0,
    content: "Checked the synchronization path.",
    contentType: "text" as const,
    final: false,
};

async function createCrypto(): Promise<SyncV4Crypto> {
    return SyncV4Crypto.create({
        sessionId: "session-1",
        sessionKey,
        randomBytes: () => nonce,
    });
}

describe("SyncV4Crypto", () => {
    it("derives deterministic opaque entity IDs", async () => {
        const crypto = await createCrypto();
        await expect(crypto.opaqueEntityId("codex.part", "part-1"))
            .resolves.toBe(opaqueEntityId);
        await expect(crypto.opaqueEntityId("codex.item", "part-1"))
            .resolves.not.toBe(opaqueEntityId);
    });

    it("encrypts and authenticates a stable cross-platform vector", async () => {
        const crypto = await createCrypto();
        const entityId = await crypto.opaqueEntityId(entity.entityType, entity.providerId);
        const aad = {
            sessionId: "session-1",
            entityId,
            entityType: entity.entityType,
            revision: 1,
            op: "upsert" as const,
        };
        const ciphertext = await crypto.encryptEntity(aad, entity);
        expect(ciphertext).toBe(encryptedVector);
        await expect(crypto.decryptEntity(aad, ciphertext)).resolves.toEqual(entity);
    });

    it("rejects tampered AAD and ciphertext", async () => {
        const crypto = await createCrypto();
        const entityId = await crypto.opaqueEntityId(entity.entityType, entity.providerId);
        const aad = {
            sessionId: "session-1",
            entityId,
            entityType: entity.entityType,
            revision: 1,
            op: "upsert" as const,
        };
        const ciphertext = await crypto.encryptEntity(aad, entity);
        await expect(crypto.decryptEntity({ ...aad, revision: 2 }, ciphertext))
            .rejects.toBeInstanceOf(SyncV4DecryptionError);

        const tampered = decodeBase64(ciphertext);
        tampered[tampered.length - 1] ^= 1;
        await expect(crypto.decryptEntity(aad, encodeBase64(tampered)))
            .rejects.toBeInstanceOf(SyncV4DecryptionError);
    });

    it.each([
        {
            name: "missing required fields",
            invalidEntity: {
                ...entity,
                itemId: undefined,
            },
            expectedMessage: "itemId",
        },
        {
            name: "content beyond the UTF-8 part limit",
            invalidEntity: {
                ...entity,
                content: "\u754c".repeat(Math.floor(MAX_CODEX_SYNC_V4_PART_BYTES / 3) + 1),
            },
            expectedMessage: `part content exceeds ${MAX_CODEX_SYNC_V4_PART_BYTES} UTF-8 bytes`,
        },
    ])("rejects $name before deriving an opaque ID", async ({ invalidEntity, expectedMessage }) => {
        const crypto = await createCrypto();
        const opaqueEntityIdSpy = vi.spyOn(crypto, "opaqueEntityId");
        const aad = {
            sessionId: "session-1",
            entityId: opaqueEntityId,
            entityType: entity.entityType,
            revision: 1,
            op: "upsert" as const,
        };

        await expect(crypto.encryptEntity(aad, invalidEntity as CodexEntityV4))
            .rejects.toThrow(expectedMessage);
        expect(opaqueEntityIdSpy).not.toHaveBeenCalled();
    });
});
