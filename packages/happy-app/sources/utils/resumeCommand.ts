export type ResumeCommandMetadata = {
    flavor?: string | null;
    codexThreadId?: string | null;
    codexSyncVersion?: number | null;
    codexReadOnly?: boolean | null;
    happySessionId?: string | null;
};

export type ResumeCommandBlock = {
    lines: string[];
    copyText: string;
};

function buildResumeInvocation(metadata: ResumeCommandMetadata): string | null {
    if (
        metadata.flavor === 'codex'
        && metadata.codexSyncVersion === 4
        && metadata.codexReadOnly !== true
        && metadata.codexThreadId
        && metadata.happySessionId
    ) {
        return `happy resume ${metadata.happySessionId}`;
    }
    return null;
}

export function buildResumeCommandBlock(metadata: ResumeCommandMetadata): ResumeCommandBlock | null {
    const invocation = buildResumeInvocation(metadata);
    if (!invocation) {
        return null;
    }

    const lines = [invocation];

    return {
        lines,
        copyText: lines.join('\n'),
    };
}

export function buildResumeCommand(metadata: ResumeCommandMetadata): string | null {
    const commandBlock = buildResumeCommandBlock(metadata);
    if (!commandBlock) {
        return null;
    }
    return commandBlock.copyText;
}
