#!/usr/bin/env node

/**
 * Scenario-driven Codex app-server double for local transport and chaos tests.
 * Stdout is reserved for JSON-RPC. Diagnostics never include request payloads.
 */

const { readFileSync } = require('node:fs');
const readline = require('node:readline');

const scenario = loadScenario();
const rules = Array.isArray(scenario.rules) ? scenario.rules : [];
const useDefaults = scenario.defaultBehavior !== false;
const strictStableV2 = scenario.strictStableV2 === true;
const occurrences = new Map();
const threads = new Map();
const activeTurns = new Map();
const timers = new Set();
let nextThread = 1;
let nextTurn = 1;
let nextItem = 1;
let nextServerRequest = 1;

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    handleMessage(message);
});

input.on('close', () => {
    clearTimers();
});

process.on('SIGTERM', () => {
    clearTimers();
    process.exit(0);
});

function loadScenario() {
    const argumentIndex = process.argv.indexOf('--scenario');
    const path = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : process.env.HAPPY_FAKE_CODEX_SCENARIO;
    if (!path) return {};
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        process.stderr.write('fake codex app-server: invalid scenario\n');
        process.exit(2);
    }
}

function handleMessage(message) {
    const method = typeof message.method === 'string' ? message.method : null;
    if (!method) return;
    if (strictStableV2) {
        const validationError = validateStableV2Message(message);
        if (validationError) {
            if (message.id !== undefined && message.id !== null) {
                send({ id: message.id, error: { code: -32602, message: validationError } });
            }
            return;
        }
    }
    const occurrence = (occurrences.get(method) || 0) + 1;
    occurrences.set(method, occurrence);
    const matches = rules.filter((rule) => {
        if (!rule || typeof rule !== 'object') return false;
        const ruleMethod = typeof rule.on === 'string' ? rule.on : rule.method;
        return ruleMethod === method
            && (rule.occurrence === undefined || rule.occurrence === occurrence);
    });
    let passthrough = matches.length === 0;
    for (const rule of matches) {
        for (const action of Array.isArray(rule.actions) ? rule.actions : []) {
            scheduleAction(action, message);
        }
        if (rule.passthrough === true) passthrough = true;
    }
    if (passthrough && useDefaults) handleDefault(message);
}

function scheduleAction(action, incoming) {
    if (!action || typeof action !== 'object') return;
    const repeat = boundedInteger(action.repeat, 1, 1_000, 1);
    const delayMs = boundedInteger(action.delayMs, 0, 15 * 60_000, 0);
    const intervalMs = boundedInteger(action.intervalMs, 0, 60_000, 0);
    for (let index = 0; index < repeat; index += 1) {
        schedule(delayMs + index * intervalMs, () => executeAction(action, incoming));
    }
}

function executeAction(action, incoming) {
    switch (action.type) {
        case 'response':
            if (incoming.id === undefined || incoming.id === null) return;
            if (Object.prototype.hasOwnProperty.call(action, 'error')) {
                send({ id: incoming.id, error: action.error });
            } else {
                send({ id: incoming.id, result: action.result === undefined ? {} : action.result });
            }
            return;
        case 'notification':
            if (typeof action.method !== 'string') return;
            send({ method: action.method, params: action.params === undefined ? {} : action.params });
            return;
        case 'request':
            if (typeof action.method !== 'string') return;
            send({
                id: action.id === undefined ? `fake-request-${nextServerRequest++}` : action.id,
                method: action.method,
                params: action.params === undefined ? {} : action.params,
            });
            return;
        case 'unknown':
            send({ method: typeof action.method === 'string' ? action.method : 'fake/unknown', params: {} });
            return;
        case 'disconnect':
            process.stdout.end();
            return;
        case 'exit':
            clearTimers();
            process.exit(boundedInteger(action.code, 0, 255, 1));
            return;
        case 'default':
            handleDefault(incoming);
    }
}

function handleDefault(message) {
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    switch (message.method) {
        case 'initialize':
            respond(message, { userAgent: 'happy-fake-codex/0.145.0' });
            return;
        case 'initialized':
            return;
        case 'thread/start': {
            const thread = createThread(params.cwd);
            respond(message, threadStartResponse(thread, params));
            send({ method: 'thread/started', params: { thread } });
            return;
        }
        case 'thread/resume':
        case 'thread/fork': {
            const sourceId = typeof params.threadId === 'string' ? params.threadId : null;
            const thread = message.method === 'thread/fork'
                ? createThread(params.cwd, sourceId)
                : threads.get(sourceId) || createThread(params.cwd, null, sourceId);
            respond(message, threadStartResponse(thread, params));
            return;
        }
        case 'thread/read': {
            const threadId = typeof params.threadId === 'string' ? params.threadId : `fake-thread-${nextThread++}`;
            const thread = threads.get(threadId) || createThread(process.cwd(), null, threadId);
            respond(message, { thread });
            return;
        }
        case 'thread/goal/get':
            respond(message, { goal: null });
            return;
        case 'thread/goal/set': {
            const now = Math.floor(Date.now() / 1_000);
            const goal = {
                threadId: params.threadId,
                objective: typeof params.objective === 'string' ? params.objective : 'fake goal',
                status: params.status || 'active',
                tokenBudget: params.tokenBudget === undefined ? null : params.tokenBudget,
                tokensUsed: 0,
                timeUsedSeconds: 0,
                createdAt: now,
                updatedAt: now,
            };
            respond(message, { goal });
            send({ method: 'thread/goal/updated', params: { threadId: params.threadId, turnId: null, goal } });
            return;
        }
        case 'thread/goal/clear':
            respond(message, { cleared: true });
            send({ method: 'thread/goal/cleared', params: { threadId: params.threadId } });
            return;
        case 'model/list':
            respond(message, { data: [], nextCursor: null });
            return;
        case 'skills/list':
            respond(message, { data: [] });
            return;
        case 'mcpServerStatus/list':
            respond(message, { data: [], nextCursor: null });
            return;
        case 'turn/start':
            startDefaultTurn(message, params);
            return;
        case 'turn/steer':
            respond(message, {});
            return;
        case 'turn/interrupt':
            interruptDefaultTurn(message, params);
            return;
        case 'thread/compact/start': {
            respond(message, {});
            const item = { type: 'contextCompaction', id: `fake-item-${nextItem++}` };
            const turnId = `fake-turn-${nextTurn++}`;
            schedule(0, () => send({
                method: 'item/started',
                params: { threadId: params.threadId, turnId, item, startedAtMs: Date.now() },
            }));
            schedule(2, () => send({
                method: 'item/completed',
                params: { threadId: params.threadId, turnId, item, completedAtMs: Date.now() },
            }));
            return;
        }
        case 'review/start': {
            const turn = createTurn();
            respond(message, { turn, reviewThreadId: params.threadId });
            return;
        }
        default:
            if (message.id !== undefined && message.id !== null) respond(message, {});
    }
}

function startDefaultTurn(message, params) {
    const threadId = typeof params.threadId === 'string' ? params.threadId : `fake-thread-${nextThread++}`;
    if (!threads.has(threadId)) createThread(process.cwd(), null, threadId);
    const turn = createTurn();
    activeTurns.set(threadId, turn);
    respond(message, { turn });
    const userItem = {
        type: 'userMessage',
        id: `fake-item-${nextItem++}`,
        clientId: typeof params.clientUserMessageId === 'string' ? params.clientUserMessageId : null,
        content: Array.isArray(params.input) ? params.input : [],
    };
    const agentItemId = `fake-item-${nextItem++}`;
    const startedAgentItem = {
        type: 'agentMessage',
        id: agentItemId,
        text: '',
        phase: null,
        memoryCitation: null,
    };
    const completedAgentItem = { ...startedAgentItem, text: 'Fake Codex response' };
    schedule(0, () => send({ method: 'turn/started', params: { threadId, turn } }));
    schedule(1, () => send({
        method: 'item/started',
        params: { threadId, turnId: turn.id, item: userItem },
    }));
    schedule(2, () => send({
        method: 'item/completed',
        params: { threadId, turnId: turn.id, item: userItem },
    }));
    schedule(3, () => send({
        method: 'item/started',
        params: { threadId, turnId: turn.id, item: startedAgentItem },
    }));
    schedule(5, () => send({
        method: 'item/agentMessage/delta',
        params: { threadId, turnId: turn.id, itemId: agentItemId, delta: 'Fake Codex response' },
    }));
    schedule(7, () => send({
        method: 'item/completed',
        params: { threadId, turnId: turn.id, item: completedAgentItem },
    }));
    schedule(9, () => {
        const completed = {
            ...turn,
            items: [userItem, completedAgentItem],
            status: 'completed',
            completedAt: nowSeconds(),
            durationMs: 9,
        };
        activeTurns.delete(threadId);
        const thread = threads.get(threadId);
        if (thread) {
            thread.turns.push(completed);
            thread.status = { type: 'idle' };
            thread.updatedAt = nowSeconds();
        }
        send({ method: 'turn/completed', params: { threadId, turn: completed } });
    });
}

function interruptDefaultTurn(message, params) {
    respond(message, {});
    const threadId = params.threadId;
    const turn = activeTurns.get(threadId);
    if (!turn) return;
    const interrupted = { ...turn, status: 'interrupted', completedAt: nowSeconds(), durationMs: 0 };
    activeTurns.delete(threadId);
    schedule(0, () => send({ method: 'turn/completed', params: { threadId, turn: interrupted } }));
}

function createThread(cwd, forkedFromId = null, explicitId = null) {
    const id = explicitId || `fake-thread-${nextThread++}`;
    const now = nowSeconds();
    const thread = {
        id,
        sessionId: 'fake-session',
        forkedFromId,
        parentThreadId: null,
        preview: '',
        ephemeral: false,
        modelProvider: 'openai',
        createdAt: now,
        updatedAt: now,
        recencyAt: now,
        status: { type: 'idle' },
        path: null,
        cwd: typeof cwd === 'string' ? cwd : process.cwd(),
        cliVersion: '0.145.0',
        source: 'appServer',
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
    };
    threads.set(id, thread);
    return thread;
}

function createTurn() {
    return {
        id: `fake-turn-${nextTurn++}`,
        items: [],
        itemsView: 'full',
        status: 'inProgress',
        error: null,
        startedAt: nowSeconds(),
        completedAt: null,
        durationMs: null,
    };
}

function threadStartResponse(thread, params) {
    return {
        thread,
        model: typeof params.model === 'string' ? params.model : 'gpt-5.1-codex-mini',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: thread.cwd,
        instructionSources: [],
        approvalPolicy: params.approvalPolicy || 'never',
        approvalsReviewer: 'user',
        sandbox: sandboxPolicyFromMode(params.sandbox),
        reasoningEffort: null,
    };
}

function sandboxPolicyFromMode(mode) {
    if (mode === 'read-only') return { type: 'readOnly', networkAccess: false };
    if (mode === 'workspace-write') {
        return {
            type: 'workspaceWrite',
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
        };
    }
    return { type: 'dangerFullAccess' };
}

function validateStableV2Message(message) {
    if (Object.prototype.hasOwnProperty.call(message, 'jsonrpc')) {
        return 'Codex app-server omits the jsonrpc header';
    }
    if (message.method === 'initialized') {
        return onlyKeys(message, ['method']);
    }
    const params = message.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return `${message.method} requires object params`;
    }
    switch (message.method) {
        case 'initialize': {
            const keyError = onlyKeys(params, ['clientInfo', 'capabilities']);
            if (keyError) return keyError;
            if (!params.clientInfo || typeof params.clientInfo !== 'object') return 'initialize.clientInfo is required';
            if (params.capabilities === null) return null;
            if (!params.capabilities || typeof params.capabilities !== 'object') {
                return 'initialize.capabilities must be an object or null';
            }
            if (params.capabilities.experimentalApi !== false) {
                return 'strict stable-v2 requires initialize.capabilities.experimentalApi=false';
            }
            if (typeof params.capabilities.requestAttestation !== 'boolean') {
                return 'initialize.capabilities.requestAttestation is required';
            }
            return null;
        }
        case 'thread/start':
            return onlyKeys(params, [
                'model', 'modelProvider', 'serviceTier', 'cwd', 'approvalPolicy', 'approvalsReviewer',
                'sandbox', 'config', 'serviceName', 'baseInstructions', 'developerInstructions',
                'personality', 'ephemeral', 'sessionStartSource', 'threadSource',
            ]) || validateApprovalPolicy(params.approvalPolicy);
        case 'thread/resume':
            return onlyKeys(params, [
                'threadId', 'model', 'modelProvider', 'serviceTier', 'cwd', 'approvalPolicy',
                'approvalsReviewer', 'sandbox', 'config', 'baseInstructions', 'developerInstructions',
                'personality',
            ]) || requiredString(params.threadId, 'thread/resume.threadId')
                || validateApprovalPolicy(params.approvalPolicy);
        case 'thread/fork':
            return onlyKeys(params, [
                'threadId', 'lastTurnId', 'model', 'modelProvider', 'serviceTier', 'cwd',
                'approvalPolicy', 'approvalsReviewer', 'sandbox', 'config', 'baseInstructions',
                'developerInstructions', 'ephemeral', 'threadSource',
            ]) || requiredString(params.threadId, 'thread/fork.threadId')
                || validateApprovalPolicy(params.approvalPolicy);
        case 'turn/start':
            return onlyKeys(params, [
                'threadId', 'clientUserMessageId', 'input', 'cwd', 'approvalPolicy', 'approvalsReviewer',
                'sandboxPolicy', 'model', 'serviceTier', 'effort', 'summary', 'personality', 'outputSchema',
            ]) || requiredString(params.threadId, 'turn/start.threadId')
                || validateUserInput(params.input)
                || validateApprovalPolicy(params.approvalPolicy)
                || validateSandboxPolicy(params.sandboxPolicy);
        case 'turn/steer':
            return onlyKeys(params, ['threadId', 'clientUserMessageId', 'input', 'expectedTurnId'])
                || requiredString(params.threadId, 'turn/steer.threadId')
                || requiredString(params.expectedTurnId, 'turn/steer.expectedTurnId')
                || validateUserInput(params.input);
        case 'turn/interrupt':
            return onlyKeys(params, ['threadId', 'turnId'])
                || requiredString(params.threadId, 'turn/interrupt.threadId')
                || requiredString(params.turnId, 'turn/interrupt.turnId');
        default:
            return null;
    }
}

function onlyKeys(value, allowed) {
    const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
    return unexpected.length > 0 ? `unexpected field: ${unexpected[0]}` : null;
}

function requiredString(value, path) {
    return typeof value === 'string' && value.length > 0 ? null : `${path} is required`;
}

function validateApprovalPolicy(value) {
    if (value === undefined || value === null) return null;
    if (value === 'untrusted' || value === 'on-request' || value === 'never') return null;
    if (value && typeof value === 'object' && !Array.isArray(value) && value.granular) return null;
    return 'approvalPolicy is not part of stable-v2';
}

function validateUserInput(input) {
    if (!Array.isArray(input)) return 'input must be an array';
    for (const item of input) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.type !== 'string') {
            return 'input contains an invalid item';
        }
        if (item.type === 'text'
            && (typeof item.text !== 'string' || !Array.isArray(item.text_elements))) {
            return 'text input requires text and text_elements';
        }
    }
    return null;
}

function validateSandboxPolicy(policy) {
    if (policy === undefined || policy === null || policy.type === 'dangerFullAccess') return null;
    if (policy.type === 'readOnly') {
        return typeof policy.networkAccess === 'boolean' ? null : 'readOnly.networkAccess is required';
    }
    if (policy.type === 'workspaceWrite') {
        return Array.isArray(policy.writableRoots)
            && typeof policy.networkAccess === 'boolean'
            && typeof policy.excludeTmpdirEnvVar === 'boolean'
            && typeof policy.excludeSlashTmp === 'boolean'
            ? null
            : 'workspaceWrite policy is incomplete';
    }
    return 'sandboxPolicy type is invalid';
}

function respond(message, result) {
    if (message.id === undefined || message.id === null) return;
    send({ id: message.id, result });
}

function send(message) {
    if (process.stdout.destroyed || process.stdout.writableEnded) return;
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function schedule(delayMs, callback) {
    const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
    }, delayMs);
    timers.add(timer);
}

function clearTimers() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
}

function boundedInteger(value, minimum, maximum, fallback) {
    return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function nowSeconds() {
    return Math.floor(Date.now() / 1_000);
}
