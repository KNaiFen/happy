import { describe, expect, it } from 'vitest';
import type { Thread, ThreadStatus, Turn, TurnStatus } from './protocol';
import { CodexThreadRegistry } from './codexThreadRegistry';

function turn(id: string, status: TurnStatus = 'inProgress'): Turn {
    return {
        id,
        items: [],
        itemsView: 'full',
        status,
        error: null,
        startedAt: 1,
        completedAt: status === 'inProgress' ? null : 2,
        durationMs: status === 'inProgress' ? null : 1_000,
    };
}

function thread(id: string, status: ThreadStatus, turns: Turn[] = []): Thread {
    return {
        id,
        sessionId: id,
        forkedFromId: null,
        parentThreadId: null,
        preview: '',
        ephemeral: false,
        modelProvider: 'openai',
        createdAt: 1,
        updatedAt: 1,
        recencyAt: 1,
        status,
        path: null,
        cwd: '/tmp',
        cliVersion: '0.145.0',
        source: 'appServer',
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns,
    };
}

describe('CodexThreadRegistry', () => {
    it('enumerates every active thread independently of selection', () => {
        const registry = new CodexThreadRegistry();
        registry.selectThread('selected-idle');
        registry.registerThread(thread('selected-idle', { type: 'idle' }));
        registry.beginTurn('pending-start');
        registry.registerThread(thread('status-active', { type: 'active', activeFlags: [] }));
        registry.registerTurn('turn-active', turn('turn-active-1'));
        registry.registerThread(thread('completed', { type: 'idle' }, [turn('completed-1', 'completed')]));

        expect(registry.activeThreadIds()).toEqual([
            'pending-start',
            'status-active',
            'turn-active',
        ]);
        expect(registry.selectedThreadIdValue).toBe('selected-idle');
    });

    it('keeps parent and child active turns isolated under interleaved notifications', async () => {
        const registry = new CodexThreadRegistry();
        registry.selectThread('parent');
        const parentWait = registry.beginTurn('parent');
        const childWait = registry.beginTurn('child');

        registry.registerTurn('child', turn('child-turn'));
        registry.registerTurn('parent', turn('parent-turn'));
        registry.registerTurn('child', turn('child-turn', 'completed'));

        await expect(childWait.promise).resolves.toMatchObject({ threadId: 'child', turnId: 'child-turn' });
        expect(registry.selectedThreadIdValue).toBe('parent');
        expect(registry.selectedTurnId).toBe('parent-turn');
        expect(registry.hasPendingTurn('parent')).toBe(true);

        registry.registerTurn('parent', turn('parent-turn', 'completed'));
        await expect(parentWait.promise).resolves.toMatchObject({ threadId: 'parent', turnId: 'parent-turn' });
    });

    it('does not time out a long turn and resolves only on an authoritative boundary', async () => {
        const registry = new CodexThreadRegistry();
        const wait = registry.beginTurn('thread-1');
        registry.registerTurn('thread-1', turn('turn-1'));
        let settled = false;
        void wait.promise.then(() => { settled = true; });

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(settled).toBe(false);

        registry.updateThreadStatus('thread-1', { type: 'idle' });
        await expect(wait.promise).resolves.toMatchObject({
            status: 'completed',
            source: 'threadStatus',
        });
    });

    it('does not let late thread-started metadata settle a pending or active turn', async () => {
        const registry = new CodexThreadRegistry();
        const wait = registry.beginTurn('thread-1');
        let settled = false;
        void wait.promise.then(
            () => { settled = true; },
            () => { settled = true; },
        );

        registry.registerThread(
            thread('thread-1', { type: 'idle' }),
            'notification',
        );
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(registry.getThread('thread-1')?.status).toEqual({ type: 'idle' });

        registry.registerTurn('thread-1', turn('turn-1'));
        registry.registerThread(
            thread('thread-1', { type: 'idle' }),
            'notification',
        );
        await Promise.resolve();

        expect(settled).toBe(false);
        expect(registry.getThread('thread-1')).toMatchObject({
            activeTurnId: 'turn-1',
            status: { type: 'active' },
        });

        registry.registerTurn('thread-1', turn('turn-1', 'completed'));
        await expect(wait.promise).resolves.toMatchObject({
            turnId: 'turn-1',
            status: 'completed',
            source: 'turn',
        });
        expect(registry.getThread('thread-1')).toMatchObject({
            activeTurnId: null,
            status: { type: 'idle' },
        });
    });

    it('does not leave a synthetic active status after a definitive turn start failure', async () => {
        const registry = new CodexThreadRegistry();
        registry.registerThread(thread('thread-1', { type: 'idle' }));
        const wait = registry.beginTurn('thread-1');

        registry.registerThread(
            thread('thread-1', { type: 'idle' }),
            'notification',
        );
        registry.failTurnStart('thread-1', new Error('turn/start failed'));

        await expect(wait.promise).rejects.toThrow('turn/start failed');
        expect(registry.activeThreadIds()).not.toContain('thread-1');
        expect(registry.getThread('thread-1')).toMatchObject({
            activeTurnId: null,
            status: { type: 'idle' },
        });
    });

    it('does not let thread-started metadata overwrite an authoritative system error', () => {
        const registry = new CodexThreadRegistry();
        registry.registerThread(thread('thread-1', { type: 'idle' }));
        registry.updateThreadStatus('thread-1', { type: 'systemError' });

        registry.registerThread(
            thread('thread-1', { type: 'idle' }),
            'notification',
        );

        expect(registry.getThread('thread-1')?.status).toEqual({ type: 'systemError' });
    });

    it('recovers an in-flight completion from a resumed thread snapshot', async () => {
        const registry = new CodexThreadRegistry();
        const wait = registry.beginTurn('thread-1');
        registry.registerTurn('thread-1', turn('turn-1'));

        registry.registerThread(
            thread('thread-1', { type: 'idle' }, [turn('turn-1', 'completed')]),
            'snapshot',
        );

        await expect(wait.promise).resolves.toMatchObject({
            turnId: 'turn-1',
            status: 'completed',
            source: 'snapshot',
        });
    });

    it('does not regress a terminal turn when a late in-progress snapshot arrives', async () => {
        const registry = new CodexThreadRegistry();
        const wait = registry.beginTurn('thread-1');
        registry.registerTurn('thread-1', turn('turn-1'));
        registry.registerTurn('thread-1', turn('turn-1', 'completed'));
        await expect(wait.promise).resolves.toMatchObject({ status: 'completed' });

        registry.registerTurn('thread-1', turn('turn-1', 'inProgress'), 'snapshot');

        expect(registry.getThread('thread-1')?.turns.get('turn-1')).toMatchObject({
            status: 'completed',
            settled: true,
        });
        expect(registry.hasPendingTurn('thread-1')).toBe(false);
    });

    it('does not let an older thread snapshot overwrite newer runtime state', () => {
        const registry = new CodexThreadRegistry();
        registry.registerThread({
            ...thread('thread-1', { type: 'active', activeFlags: [] }, [turn('turn-new')]),
            updatedAt: 20,
        }, 'snapshot');

        registry.registerThread({
            ...thread('thread-1', { type: 'active', activeFlags: [] }, [turn('turn-old')]),
            updatedAt: 10,
        }, 'snapshot');

        expect(registry.getThread('thread-1')).toMatchObject({
            status: { type: 'active' },
            activeTurnId: 'turn-new',
        });
        expect(registry.getThread('thread-1')?.turns.has('turn-old')).toBe(false);
        expect(registry.hasPendingTurn('thread-1')).toBe(true);
    });

    it('does not let a late older in-progress turn replace the current active turn', () => {
        const registry = new CodexThreadRegistry();
        registry.registerTurn('thread-1', {
            ...turn('turn-new'),
            startedAt: 20,
        });
        registry.registerTurn('thread-1', {
            ...turn('turn-old'),
            startedAt: 10,
        });

        expect(registry.getThread('thread-1')?.activeTurnId).toBe('turn-new');
        expect(registry.hasPendingTurn('thread-1')).toBe(true);
    });

    it('does not let an older turn completion clear a newer active turn', () => {
        const registry = new CodexThreadRegistry();
        registry.registerTurn('thread-1', {
            ...turn('turn-old'),
            startedAt: 10,
        });
        registry.registerTurn('thread-1', {
            ...turn('turn-new'),
            startedAt: 20,
        });

        registry.registerTurn('thread-1', {
            ...turn('turn-old', 'completed'),
            startedAt: 10,
        });

        expect(registry.getThread('thread-1')?.activeTurnId).toBe('turn-new');
        expect(registry.hasPendingTurn('thread-1')).toBe(true);
    });

    it('does not bind a pending start to an older turn in a resume snapshot', async () => {
        const registry = new CodexThreadRegistry();
        registry.registerThread(thread('thread-1', { type: 'idle' }, [turn('old-turn', 'completed')]));
        const wait = registry.beginTurn('thread-1');

        registry.registerThread(
            thread('thread-1', { type: 'idle' }, [
                turn('old-turn', 'completed'),
                turn('new-turn', 'completed'),
            ]),
            'snapshot',
        );

        await expect(wait.promise).resolves.toMatchObject({
            turnId: 'new-turn',
            status: 'completed',
            source: 'snapshot',
        });
    });

    it('creates one placeholder and one hydration request for an unknown thread', () => {
        const registry = new CodexThreadRegistry();

        expect(registry.ensureThread('unknown').created).toBe(true);
        expect(registry.ensureThread('unknown').created).toBe(false);
        expect(registry.markHydrationRequested('unknown')).toBe(true);
        expect(registry.markHydrationRequested('unknown')).toBe(false);
        expect(registry.getThread('unknown')).toMatchObject({ placeholder: true, hydrationRequested: true });
    });

    it('forgets only the selected thread without affecting a child runtime', () => {
        const registry = new CodexThreadRegistry();
        registry.selectThread('parent');
        registry.ensureThread('child');

        registry.forgetThread('parent', new Error('cleared'));

        expect(registry.selectedThreadIdValue).toBeNull();
        expect(registry.getThread('parent')).toBeNull();
        expect(registry.getThread('child')).not.toBeNull();
    });
});
