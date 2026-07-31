/** Converts a local slash command into the compact chat representation. */

export type LocalCommandMessage =
    | { kind: 'command-run'; commandName: string; args?: string }
    | { kind: 'goal-run'; goal: string }
    | { kind: 'text'; text: string };

const RAW_SLASH_COMMAND_RE = /^\s*\/([a-zA-Z][\w:-]*)(?:\s+([\s\S]*?))?\s*$/;
const RAW_SLASH_COMMAND_TOKEN_RE = /(^|\s)\/([a-zA-Z][\w:-]*)(?=$|\s)/;

function rawSlashCommand(text: string): { commandName: string; args?: string } | undefined {
    const match = text.match(RAW_SLASH_COMMAND_RE);
    if (match) {
        const commandName = match[1].trim();
        const args = match[2]?.trim();
        return {
            commandName,
            args: args && args.length > 0 ? args : undefined,
        };
    }

    const tokenMatch = text.match(RAW_SLASH_COMMAND_TOKEN_RE);
    if (!tokenMatch || tokenMatch.index === undefined) {
        return undefined;
    }
    const commandStart = tokenMatch.index + tokenMatch[1].length;
    const commandEnd = commandStart + tokenMatch[2].length + 1;
    const before = text.slice(0, commandStart).trim();
    const after = text.slice(commandEnd).trim();
    const args = [before, after].filter(Boolean).join(' ');
    return {
        commandName: tokenMatch[2].trim(),
        args: args && args.length > 0 ? args : undefined,
    };
}

export function parseLocalCommandMessage(text: string): LocalCommandMessage {
    const rawCommand = rawSlashCommand(text);
    if (rawCommand) {
        if (rawCommand.commandName.toLowerCase() === 'goal' && rawCommand.args) {
            return { kind: 'goal-run', goal: rawCommand.args };
        }
        return {
            kind: 'command-run',
            commandName: rawCommand.commandName,
            args: rawCommand.args,
        };
    }

    return { kind: 'text', text };
}
