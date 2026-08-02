import { createHash, timingSafeEqual } from 'node:crypto';
import { CodexGatewayProxy } from './codexGatewayProxy';

export interface CodexGatewayTuiRelay {
    remoteUrl: string;
    close(): Promise<void>;
}

export async function startCodexGatewayTuiRelay(options: {
    upstreamSocketPath: string;
    bearerToken: string;
}): Promise<CodexGatewayTuiRelay> {
    let claimed = false;
    const proxy = new CodexGatewayProxy(
        { url: 'ws://127.0.0.1:0' },
        {
            socketPath: options.upstreamSocketPath,
            bearerToken: options.bearerToken,
        },
        {
            claimTerminal: (_connectionId, bearerToken) => {
                if (claimed || !bearerToken) return false;
                if (!secureEqual(bearerToken, options.bearerToken)) return false;
                claimed = true;
                return true;
            },
        },
    );
    const bound = await proxy.start();
    if (!bound.url) {
        await proxy.close();
        throw new Error('Codex Gateway TUI relay did not bind to loopback');
    }
    return {
        remoteUrl: bound.url,
        close: () => proxy.close(),
    };
}

function secureEqual(left: string, right: string): boolean {
    const leftHash = createHash('sha256').update(left).digest();
    const rightHash = createHash('sha256').update(right).digest();
    return timingSafeEqual(leftHash, rightHash);
}
