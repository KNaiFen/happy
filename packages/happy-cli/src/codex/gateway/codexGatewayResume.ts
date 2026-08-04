import { ApiClient } from '@/api/api';
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { assertMinimumCodexCliVersion } from '../codexCliVersion';
import {
    attachVerifiedCodexGateway,
    inspectVerifiedGatewayForSession,
    launchCodexGatewayHeadless,
    launchCodexGatewayResumeTui,
    reconcileVerifiedGatewayPresence,
    type CodexGatewayHeadlessLaunchResult,
} from './codexGatewayLauncher';
import {
    CodexGatewayResumeBootstrapSchema,
    type CodexGatewayResumeBootstrap,
} from './codexGatewayState';

type SessionUnarchiveClient = Pick<ApiClient, 'unarchiveSession'>;

export function createCodexGatewayResumeBootstrap(
    input: CodexGatewayResumeBootstrap,
): CodexGatewayResumeBootstrap {
    return CodexGatewayResumeBootstrapSchema.parse(input);
}

export async function resumeCodexGatewayHeadless(options: {
    api: SessionUnarchiveClient;
    bootstrap: CodexGatewayResumeBootstrap;
    env: NodeJS.ProcessEnv;
    operationId?: string;
}): Promise<CodexGatewayHeadlessLaunchResult> {
    const bootstrap = CodexGatewayResumeBootstrapSchema.parse(options.bootstrap);
    const inspected = await prepareCodexGatewayResume(options.api, bootstrap);
    if (inspected.state === 'recovering') {
        throw new Error('The existing Codex Gateway is still recovering. Retry after it settles.');
    }
    if (inspected.state === 'live') {
        const gateway = inspected.gateway!;
        const binding = gateway.descriptor.current;
        if (!binding) throw new Error('The verified Codex Gateway lost its current binding');
        return {
            gatewayId: gateway.descriptor.gatewayId,
            threadId: binding.threadId,
            sessionId: binding.sessionId!,
            generation: binding.generation,
            pid: gateway.descriptor.pid,
            descriptor: gateway.descriptor,
        };
    }

    const launched = await launchCodexGatewayHeadless({
        operationId: options.operationId,
        cwd: bootstrap.cwd,
        env: options.env,
        action: 'resume',
        resumeBootstrap: bootstrap,
    });
    if (
        launched.sessionId !== bootstrap.happySessionId
        || launched.threadId !== bootstrap.threadId
    ) {
        throw new Error('Codex Gateway resumed a different session or thread identity');
    }
    return launched;
}

export async function resumeCodexGatewayTui(
    input: CodexGatewayResumeBootstrap,
): Promise<number> {
    assertMinimumCodexCliVersion();
    const bootstrap = CodexGatewayResumeBootstrapSchema.parse(input);
    const { credentials } = await authAndSetupMachineIfNeeded();
    await ensureDaemonRunning();
    const api = await ApiClient.create(credentials);
    const inspected = await prepareCodexGatewayResume(api, bootstrap);
    if (inspected.state === 'recovering') {
        throw new Error('The existing Codex Gateway is still recovering. Retry after it settles.');
    }
    if (inspected.state === 'live') {
        return await attachVerifiedCodexGateway({
            descriptor: inspected.gateway!.descriptor,
            secret: inspected.gateway!.secret,
            threadId: bootstrap.threadId,
        });
    }
    return await launchCodexGatewayResumeTui(bootstrap);
}

async function prepareCodexGatewayResume(
    api: SessionUnarchiveClient,
    bootstrap: CodexGatewayResumeBootstrap,
): ReturnType<typeof inspectVerifiedGatewayForSession> {
    if (!await api.unarchiveSession(bootstrap.happySessionId)) {
        throw new Error('Happy Relay is unavailable; the session was not resumed');
    }
    const inspected = await inspectVerifiedGatewayForSession({
        sessionId: bootstrap.happySessionId,
        threadId: bootstrap.threadId,
    });
    if (inspected.state === 'live') {
        await reconcileVerifiedGatewayPresence({
            gateway: inspected.gateway!,
            sessionId: bootstrap.happySessionId,
        });
    }
    return inspected;
}
