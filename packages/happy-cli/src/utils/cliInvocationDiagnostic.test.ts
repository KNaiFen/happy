import { describe, expect, it } from 'vitest';
import { cliInvocationDiagnostic } from './cliInvocationDiagnostic';

describe('CLI invocation diagnostics', () => {
  it('keeps prompt text and unknown command values out of operational metadata', () => {
    const prompt = 'private-terminal-prompt-71b408';

    const codex = cliInvocationDiagnostic(['codex', '--no-alt-screen', prompt]);
    const unknown = cliInvocationDiagnostic([prompt, '--token', 'private-token']);

    expect(codex).toEqual({ commandFamily: 'codex', argumentCount: 3 });
    expect(unknown).toEqual({ commandFamily: 'default', argumentCount: 3 });
    expect(JSON.stringify({ codex, unknown })).not.toContain(prompt);
    expect(JSON.stringify({ codex, unknown })).not.toContain('private-token');
  });
});
