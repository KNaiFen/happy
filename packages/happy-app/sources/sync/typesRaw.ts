import * as z from 'zod';
import { isCuid } from '@paralleldrive/cuid2';
import { stripLeadingTaskNotificationWrappers } from '@slopus/happy-wire';
import { MessageMetaSchema, MessageMeta } from './typesMessageMeta';

//
// Raw types
//

// Provider-neutral usage data projected by v3 session envelopes.
const usageDataSchema = z.object({
    input_tokens: z.number(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    output_tokens: z.number(),
    context_window: z.number().optional(),
    service_tier: z.string().optional(),
}).passthrough();

export type UsageData = z.infer<typeof usageDataSchema>;

const agentEventSchema = z.discriminatedUnion('type', [z.object({
    type: z.literal('switch'),
    mode: z.enum(['local', 'remote'])
}), z.object({
    type: z.literal('message'),
    message: z.string(),
}), z.object({
    type: z.literal('limit-reached'),
    endsAt: z.number(),
}), z.object({
    type: z.literal('ready'),
})]);
export type AgentEvent = z.infer<typeof agentEventSchema>;

const sessionTextEventSchema = z.object({
    t: z.literal('text'),
    text: z.string(),
    thinking: z.boolean().optional(),
});

const sessionServiceMessageEventSchema = z.object({
    t: z.literal('service'),
    text: z.string(),
});

const sessionToolCallStartEventSchema = z.object({
    t: z.literal('tool-call-start'),
    call: z.string(),
    name: z.string(),
    title: z.string(),
    description: z.string(),
    args: z.record(z.string(), z.unknown()),
});

const sessionToolCallEndEventSchema = z.object({
    t: z.literal('tool-call-end'),
    call: z.string(),
});

const sessionFileEventSchema = z.object({
    t: z.literal('file'),
    ref: z.string(),
    name: z.string(),
    size: z.number(),
    image: z.object({
        width: z.number(),
        height: z.number(),
        // Optional — native iOS image-picker has no Canvas to compute it.
        // FileView falls back to no blurry placeholder; the real picture
        // is decrypted on render anyway.
        thumbhash: z.string().optional(),
    }).optional(),
});

const sessionTurnStartEventSchema = z.object({
    t: z.literal('turn-start'),
});

const sessionStartEventSchema = z.object({
    t: z.literal('start'),
    title: z.string().optional(),
});

const sessionTurnEndEventSchema = z.object({
    t: z.literal('turn-end'),
    status: z.enum(['completed', 'failed', 'cancelled']),
});

const sessionStopEventSchema = z.object({
    t: z.literal('stop'),
});

const sessionEventSchema = z.discriminatedUnion('t', [
    sessionTextEventSchema,
    sessionServiceMessageEventSchema,
    sessionToolCallStartEventSchema,
    sessionToolCallEndEventSchema,
    sessionFileEventSchema,
    sessionTurnStartEventSchema,
    sessionStartEventSchema,
    sessionTurnEndEventSchema,
    sessionStopEventSchema,
]);

const sessionEnvelopeSchema = z.object({
    id: z.string(),
    time: z.number(),
    role: z.enum(['user', 'agent']),
    turn: z.string().optional(),
    subagent: z.string().refine((value) => isCuid(value), {
        message: 'subagent must be a cuid2 value',
    }).optional(),
    // Codex app-server item id for precise thread rollback points.
    codexItemId: z.string().min(1).optional(),
    // Optional model usage from the source agent message. The reducer uses it
    // for context meters; it is not rendered as a separate chat row.
    usage: usageDataSchema.optional(),
    ev: sessionEventSchema,
}).superRefine((envelope, ctx) => {
    if (envelope.ev.t === 'service' && envelope.role !== 'agent') {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'service events must use role "agent"',
            path: ['role'],
        });
    }
    if ((envelope.ev.t === 'start' || envelope.ev.t === 'stop') && envelope.role !== 'agent') {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${envelope.ev.t} events must use role "agent"`,
            path: ['role'],
        });
    }
});
type SessionEnvelope = z.infer<typeof sessionEnvelopeSchema>;

const rawAgentRecordSchema = z.discriminatedUnion('type', [z.object({
    type: z.literal('output'),
    data: z.unknown(),
}).passthrough(), z.object({
    type: z.literal('event'),
    id: z.string(),
    data: agentEventSchema
}), z.object({
    type: z.literal('codex'),
    data: z.discriminatedUnion('type', [
        z.object({ type: z.literal('reasoning'), message: z.string() }),
        z.object({ type: z.literal('message'), message: z.string() }),
        z.object({
            type: z.literal('tool-call'),
            callId: z.string(),
            input: z.any(),
            name: z.string(),
            id: z.string()
        }),
        z.object({
            type: z.literal('tool-call-result'),
            callId: z.string(),
            output: z.any(),
            id: z.string()
        })
    ])
}), z.object({
    type: z.literal('session'),
    data: sessionEnvelopeSchema
})]);

/**
 * Preprocessor: Normalizes hyphenated content types to canonical before validation
 * This avoids Zod v4's "unmergable intersection" issue with transforms inside complex schemas
 * See: https://github.com/colinhacks/zod/discussions/2100
 */
function preprocessMessageContent(data: any): any {
    if (!data || typeof data !== 'object') return data;

    // Accept new session wrapper shape and normalize to canonical wrapped shape.
    // New shape:
    // { role: 'session', content: { id, role, turn?, subagent?, ev }, meta? }
    if (data.role === 'session' && data.content && typeof data.content === 'object') {
        const content = data.content as Record<string, unknown>;
        const looksLikeEnvelope = content.type !== 'session'
            && typeof content.id === 'string'
            && typeof content.role === 'string'
            && content.ev !== undefined;
        if (looksLikeEnvelope) {
            data.content = {
                type: 'session',
                data: content,
            };
        }
    }

    return data;
}

const rawRecordSchema = z.preprocess(
    preprocessMessageContent,
    z.discriminatedUnion('role', [
        z.object({
            role: z.literal('agent'),
            content: rawAgentRecordSchema,
            meta: MessageMetaSchema.optional()
        }),
        z.object({
            role: z.literal('user'),
            content: z.object({
                type: z.literal('text'),
                text: z.string()
            }),
            localKey: z.string().optional(),
            meta: MessageMetaSchema.optional()
        }),
        z.object({
            role: z.literal('session'),
            content: z.object({
                type: z.literal('session'),
                data: sessionEnvelopeSchema
            }),
            meta: MessageMetaSchema.optional()
        })
    ])
);

export type RawRecord = z.infer<typeof rawRecordSchema>;

// Export schemas for validation
export const RawRecordSchema = rawRecordSchema;


//
// Normalized types
//

type NormalizedAgentContent =
    {
        type: 'text';
        text: string;
        uuid: string;
        parentUUID: string | null;
    } | {
        type: 'thinking';
        thinking: string;
        uuid: string;
        parentUUID: string | null;
    } | {
        type: 'tool-call';
        id: string;
        name: string;
        input: any;
        description: string | null;
        uuid: string;
        parentUUID: string | null;
    } | {
        type: 'tool-result'
        tool_use_id: string;
        content: any;
        is_error: boolean;
        uuid: string;
        parentUUID: string | null;
        permissions?: {
            date: number;
            result: 'approved' | 'denied';
            mode?: string;
            allowedTools?: string[];
            decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
        };
    } | {
        type: 'summary',
        summary: string;
    } | {
        type: 'sidechain'
        uuid: string;
        prompt: string
    };

export type NormalizedMessage = ({
    role: 'user'
    content: {
        type: 'text';
        text: string;
    }
} | {
    role: 'agent'
    content: NormalizedAgentContent[]
} | {
    role: 'event'
    content: AgentEvent
}) & {
    id: string,
    localId: string | null,
    createdAt: number,
    isSidechain: boolean,
    meta?: MessageMeta,
    usage?: UsageData,
    codexItemId?: string,
};

function normalizeSessionEnvelope(
    envelope: SessionEnvelope,
    localId: string | null,
    createdAt: number,
    meta: MessageMeta | undefined,
): NormalizedMessage | null {
    const isUsageOnlyServiceEvent = envelope.role === 'agent'
        && envelope.ev.t === 'service'
        && envelope.ev.text.trim().length === 0
        && !!envelope.usage;

    // Session protocol requires turn id on all agent-originated envelopes.
    // Usage-only updates may arrive after turn-end, when the producer no longer has
    // an active turn to attach to; they update status bars without rendering rows.
    if (envelope.role === 'agent' && !envelope.turn && !isUsageOnlyServiceEvent) {
        return null;
    }

    const messageId = envelope.id;
    const messageCreatedAt = envelope.time;
    const parentUUID = envelope.subagent ?? null;
    const isSidechain = parentUUID !== null;
    const contentUUID = envelope.id;

    if (envelope.ev.t === 'turn-start') {
        return null;
    }

    if (envelope.ev.t === 'start' || envelope.ev.t === 'stop') {
        // Lifecycle marker for subagent boundaries; currently not rendered as chat content.
        return null;
    }

    if (envelope.ev.t === 'turn-end') {
        return {
            id: messageId,
            localId,
            createdAt: messageCreatedAt,
            role: 'event',
            isSidechain: false,
            content: { type: 'ready' },
            meta
        } satisfies NormalizedMessage;
    }

    if (envelope.ev.t === 'service') {
        if (envelope.role !== 'agent') {
            return null;
        }

        return {
            id: messageId,
            localId,
            createdAt: messageCreatedAt,
            role: 'agent',
            isSidechain,
            content: isUsageOnlyServiceEvent
                ? []
                : [{
                    type: 'text',
                    text: envelope.ev.text,
                    uuid: contentUUID,
                    parentUUID
                }],
            meta,
            usage: envelope.usage,
        } satisfies NormalizedMessage;
    }

    if (envelope.ev.t === 'text') {
        const visibleText = stripLeadingTaskNotificationWrappers(envelope.ev.text);
        if (visibleText !== envelope.ev.text && visibleText.trim().length === 0) {
            return null;
        }

        if (envelope.role === 'user') {
            return {
                id: messageId,
                localId,
                createdAt: messageCreatedAt,
                role: 'user',
                isSidechain: false,
                content: {
                    type: 'text',
                    text: visibleText
                },
                meta,
                codexItemId: envelope.codexItemId,
            } satisfies NormalizedMessage;
        }

        return {
            id: messageId,
            localId,
            createdAt: messageCreatedAt,
            role: 'agent',
            isSidechain,
            content: [
                envelope.ev.thinking ? {
                    type: 'thinking',
                    thinking: visibleText,
                    uuid: contentUUID,
                    parentUUID
                } : {
                    type: 'text',
                    text: visibleText,
                    uuid: contentUUID,
                    parentUUID
                }
            ],
            meta,
            codexItemId: envelope.codexItemId,
            usage: envelope.usage,
        } satisfies NormalizedMessage;
    }

    if (envelope.ev.t === 'tool-call-start') {
        return {
            id: messageId,
            localId,
            createdAt: messageCreatedAt,
            role: 'agent',
            isSidechain,
            content: [{
                type: 'tool-call',
                id: envelope.ev.call,
                name: envelope.ev.name || 'unknown',
                input: envelope.ev.args,
                description: envelope.ev.description,
                uuid: contentUUID,
                parentUUID
            }],
            meta,
            usage: envelope.usage,
        } satisfies NormalizedMessage;
    }

    if (envelope.ev.t === 'tool-call-end') {
        return {
            id: messageId,
            localId,
            createdAt: messageCreatedAt,
            role: 'agent',
            isSidechain,
            content: [{
                type: 'tool-result',
                tool_use_id: envelope.ev.call,
                content: null,
                is_error: false,
                uuid: contentUUID,
                parentUUID
            }],
            meta,
            usage: envelope.usage,
        } satisfies NormalizedMessage;
    }

    if (envelope.ev.t === 'file') {
        const maybeImageMetadata = envelope.ev.image
            ? {
                image: {
                    width: envelope.ev.image.width,
                    height: envelope.ev.image.height,
                    thumbhash: envelope.ev.image.thumbhash
                }
            }
            : {};

        // File events carry no separate "completed" wire signal — the upload
        // is already finished by the time the event is sent. Emit the
        // tool-call AND a paired tool-result in the same message so the
        // reducer's Phase 2 + Phase 3 see both halves and the tool flips
        // straight to "completed". Without this the chat bubble shows a
        // forever-spinning indicator next to the attachment.
        return {
            id: messageId,
            localId,
            createdAt: messageCreatedAt,
            role: 'agent',
            isSidechain,
            content: [
                {
                    type: 'tool-call',
                    id: messageId,
                    name: 'file',
                    input: {
                        ref: envelope.ev.ref,
                        name: envelope.ev.name,
                        size: envelope.ev.size,
                        ...maybeImageMetadata
                    },
                    description: envelope.ev.image
                        ? `Attached image: ${envelope.ev.name} (${envelope.ev.image.width}x${envelope.ev.image.height})`
                        : `Attached file: ${envelope.ev.name}`,
                    uuid: contentUUID,
                    parentUUID
                },
                {
                    type: 'tool-result',
                    tool_use_id: messageId,
                    content: null,
                    is_error: false,
                    uuid: `${contentUUID}:result`,
                    parentUUID: contentUUID
                }
            ],
            meta,
            usage: envelope.usage,
        } satisfies NormalizedMessage;
    }

    return null;
}

export function normalizeRawMessage(id: string, localId: string | null, createdAt: number, raw: RawRecord): NormalizedMessage | null {
    // Zod transform handles normalization during validation
    let parsed = rawRecordSchema.safeParse(raw);
    if (!parsed.success) {
        const rawObj = raw as any;
        const msgType = rawObj?.content?.data?.type ?? rawObj?.content?.type ?? 'unknown';
        console.warn(`Unrecognized message type: ${msgType} (id: ${id})`);
        return null;
    }
    raw = parsed.data;
    if (raw.meta?.followUpMode === 'queue') {
        return null;
    }
    if (raw.role === 'user') {
        return {
            id,
            localId,
            createdAt,
            role: 'user',
            content: raw.content,
            isSidechain: false,
            meta: raw.meta,
        };
    }
    if (raw.role === 'session') {
        return normalizeSessionEnvelope(
            raw.content.data,
            localId,
            createdAt,
            raw.meta,
        );
    }
    if (raw.role === 'agent') {
        if (raw.content.type === 'output') {
            return null;
        }
        if (raw.content.type === 'event') {
            return {
                id,
                localId,
                createdAt,
                role: 'event',
                content: raw.content.data,
                isSidechain: false,
            };
        }
        if (raw.content.type === 'codex') {
            if (raw.content.data.type === 'message') {
                // Cast codex messages to agent text messages
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'text',
                        text: raw.content.data.message,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                };
            }
            if (raw.content.data.type === 'reasoning') {
                // Cast codex messages to agent text messages
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'text',
                        text: raw.content.data.message,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'tool-call') {
                // Cast tool calls to agent tool-call messages
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: raw.content.data.callId,
                        name: raw.content.data.name || 'unknown',
                        input: raw.content.data.input,
                        description: null,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'tool-call-result') {
                // Cast tool call results to agent tool-result messages
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-result',
                        tool_use_id: raw.content.data.callId,
                        content: raw.content.data.output,
                        is_error: false,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
        }
        if (raw.content.type === 'session') {
            return normalizeSessionEnvelope(raw.content.data, localId, createdAt, raw.meta);
        }
    }
    return null;
}
