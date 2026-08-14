import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';
import { Artifact, ArtifactCreateRequest, ArtifactCreateResponse, ArtifactDeleteResponse, ArtifactSnapshot, ArtifactUpdateRequest, ArtifactUpdateResponse } from './artifactTypes';
import { z } from 'zod';
import { createAccountFetch } from './accountOutboundFence';

const ArtifactCreateResponseSchema = z.object({
    id: z.string(),
    header: z.string(),
    headerVersion: z.number(),
    body: z.string().optional(),
    bodyVersion: z.number().optional(),
    dataEncryptionKey: z.string(),
    seq: z.number(),
    updateSeq: z.number().int().nonnegative(),
    createdAt: z.number(),
    updatedAt: z.number(),
});

const ArtifactUpdateResponseSchema = z.union([
    z.object({
        success: z.literal(true),
        updateSeq: z.number().int().nonnegative(),
        headerVersion: z.number().optional(),
        bodyVersion: z.number().optional(),
    }),
    z.object({
        success: z.literal(false),
        error: z.literal('version-mismatch'),
        currentHeaderVersion: z.number().optional(),
        currentBodyVersion: z.number().optional(),
        currentHeader: z.string().optional(),
        currentBody: z.string().optional(),
    }),
]);

const ArtifactDeleteResponseSchema = z.object({
    success: z.literal(true),
    updateSeq: z.number().int().nonnegative(),
});

const ArtifactSnapshotPageSchema = z.object({
    artifacts: z.array(z.object({
        id: z.string(),
        header: z.string(),
        headerVersion: z.number(),
        dataEncryptionKey: z.string(),
        seq: z.number(),
        updateSeq: z.number().int().nonnegative(),
        createdAt: z.number(),
        updatedAt: z.number(),
    })),
    highWatermark: z.number().int().nonnegative(),
    nextCursor: z.string().min(1).max(4096).nullable(),
});

/**
 * Fetch all artifacts for the account
 */
export async function fetchArtifacts(credentials: AuthCredentials): Promise<ArtifactSnapshot> {
    const API_ENDPOINT = getServerUrl();
    const accountFetch = createAccountFetch(credentials.token);
    return backoff(async () => {
        const artifacts: Artifact[] = [];
        const seenArtifactIds = new Set<string>();
        const seenCursors = new Set<string>();
        let cursor: string | null = null;
        let highWatermark: number | null = null;

        while (true) {
            const query = new URLSearchParams({ limit: '100' });
            if (cursor !== null) query.set('cursor', cursor);
            const response = await accountFetch(`${API_ENDPOINT}/v1/artifacts?${query.toString()}`, {
                headers: {
                    'Authorization': `Bearer ${credentials.token}`,
                    'Content-Type': 'application/json',
                    'X-Happy-Client': getHappyClientId(),
                }
            });
            if (!response.ok) throw new Error(`Failed to fetch artifacts: ${response.status}`);
            const pageResult = ArtifactSnapshotPageSchema.parse(await response.json());
            if (highWatermark === null) highWatermark = pageResult.highWatermark;
            if (pageResult.highWatermark !== highWatermark) {
                throw new Error('Artifact snapshot high watermark changed during pagination');
            }
            for (const artifact of pageResult.artifacts) {
                if (artifact.updateSeq > highWatermark) {
                    throw new Error('Artifact snapshot row exceeds its high watermark');
                }
                if (seenArtifactIds.has(artifact.id)) {
                    throw new Error('Artifact snapshot returned a duplicate artifact');
                }
                seenArtifactIds.add(artifact.id);
                artifacts.push(artifact);
            }
            if (pageResult.nextCursor === null) {
                return { artifacts, highWatermark };
            }
            if (seenCursors.has(pageResult.nextCursor)) {
                throw new Error('Artifact snapshot returned a repeated cursor');
            }
            seenCursors.add(pageResult.nextCursor);
            cursor = pageResult.nextCursor;
        }
    });
}

/**
 * Fetch a single artifact with full body
 */
export async function fetchArtifact(credentials: AuthCredentials, artifactId: string): Promise<Artifact> {
    const API_ENDPOINT = getServerUrl();
    const accountFetch = createAccountFetch(credentials.token);

    return await backoff(async () => {
        const response = await accountFetch(`${API_ENDPOINT}/v1/artifacts/${artifactId}`, {
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            }
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new Error('Artifact not found');
            }
            throw new Error(`Failed to fetch artifact: ${response.status}`);
        }

        const data = await response.json() as Artifact;
        return data;
    });
}

/**
 * Create a new artifact
 */
export async function createArtifact(
    credentials: AuthCredentials, 
    request: ArtifactCreateRequest
): Promise<ArtifactCreateResponse> {
    const API_ENDPOINT = getServerUrl();
    const accountFetch = createAccountFetch(credentials.token);

    return await backoff(async () => {
        const response = await accountFetch(`${API_ENDPOINT}/v1/artifacts`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            },
            body: JSON.stringify(request)
        });

        if (!response.ok) {
            if (response.status === 409) {
                throw new Error('Artifact ID already exists');
            }
            throw new Error(`Failed to create artifact: ${response.status}`);
        }

        return ArtifactCreateResponseSchema.parse(await response.json()) as ArtifactCreateResponse;
    });
}

/**
 * Update an existing artifact
 */
export async function updateArtifact(
    credentials: AuthCredentials,
    artifactId: string,
    request: ArtifactUpdateRequest
): Promise<ArtifactUpdateResponse> {
    const API_ENDPOINT = getServerUrl();
    const accountFetch = createAccountFetch(credentials.token);

    return await backoff(async () => {
        const response = await accountFetch(`${API_ENDPOINT}/v1/artifacts/${artifactId}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            },
            body: JSON.stringify(request)
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new Error('Artifact not found');
            }
            throw new Error(`Failed to update artifact: ${response.status}`);
        }

        return ArtifactUpdateResponseSchema.parse(await response.json()) as ArtifactUpdateResponse;
    });
}

/**
 * Delete an artifact
 */
export async function deleteArtifact(
    credentials: AuthCredentials,
    artifactId: string
): Promise<ArtifactDeleteResponse> {
    const API_ENDPOINT = getServerUrl();
    const accountFetch = createAccountFetch(credentials.token);

    return await backoff(async () => {
        const response = await accountFetch(`${API_ENDPOINT}/v1/artifacts/${artifactId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'X-Happy-Client': getHappyClientId(),
            }
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new Error('Artifact not found');
            }
            throw new Error(`Failed to delete artifact: ${response.status}`);
        }
        return ArtifactDeleteResponseSchema.parse(await response.json()) as ArtifactDeleteResponse;
    });
}
