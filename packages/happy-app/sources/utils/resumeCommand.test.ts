import { describe, expect, it } from 'vitest';
import { buildResumeCommand, buildResumeCommandBlock } from './resumeCommand';

describe('buildResumeCommand', () => {
    it('never offers a native CLI resume command for Rig sessions', () => {
        expect(buildResumeCommand({
            path: '/tmp/project',
            flavor: 'codex',
            codexThreadId: 'thread-1',
            client: { id: 'rig' },
            capabilities: { resume: false },
        })).toBeNull();
    });
    it('builds a Codex resume command that enters the session directory first', () => {
        expect(buildResumeCommand({
            path: '/tmp/project',
            os: 'darwin',
            flavor: 'codex',
            codexThreadId: 'thread-1',
        })).toBe(`cd '/tmp/project' && happy codex --resume thread-1`);
    });

    it('builds a Windows Codex resume command using PowerShell directory navigation', () => {
        expect(buildResumeCommand({
            path: 'C:\\Users\\test\\project',
            os: 'win32',
            flavor: 'codex',
            codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
        })).toBe(`Set-Location -LiteralPath 'C:\\Users\\test\\project'; happy codex --resume 019ccca5-726b-7c61-b914-16de27dfab6e`);
    });

    it('falls back to the bare resume command when no path is available', () => {
        expect(buildResumeCommand({
            flavor: 'codex',
            codexThreadId: 'thread-1',
        })).toBe('happy codex --resume thread-1');
    });

    it('returns null when there is no resumable session identifier', () => {
        expect(buildResumeCommand({
            path: '/tmp/project',
            flavor: 'codex',
        })).toBeNull();
    });
});

describe('buildResumeCommandBlock', () => {
    it('builds copyable two-line CLI instructions when a path is available', () => {
        expect(buildResumeCommandBlock({
            path: '/tmp/project',
            os: 'darwin',
            flavor: 'codex',
            codexThreadId: 'thread-1',
        })).toEqual({
            lines: [
                `cd '/tmp/project'`,
                'happy codex --resume thread-1',
            ],
            copyText: `cd '/tmp/project'\nhappy codex --resume thread-1`,
        });
    });

    it('falls back to a single-line command block when no path is available', () => {
        expect(buildResumeCommandBlock({
            flavor: 'codex',
            codexThreadId: 'thread-1',
        })).toEqual({
            lines: ['happy codex --resume thread-1'],
            copyText: 'happy codex --resume thread-1',
        });
    });

    it('builds copyable two-line Windows instructions using PowerShell directory navigation', () => {
        expect(buildResumeCommandBlock({
            path: 'C:\\Users\\test\\project',
            os: 'win32',
            flavor: 'codex',
            codexThreadId: 'thread-1',
        })).toEqual({
            lines: [
                `Set-Location -LiteralPath 'C:\\Users\\test\\project'`,
                'happy codex --resume thread-1',
            ],
            copyText: `Set-Location -LiteralPath 'C:\\Users\\test\\project'\nhappy codex --resume thread-1`,
        });
    });
});
