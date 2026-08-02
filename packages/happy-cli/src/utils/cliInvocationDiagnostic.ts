const LOGGABLE_COMMAND_FAMILIES = new Set([
  'doctor',
  'auth',
  'connect',
  'sandbox',
  'server',
  'bye',
  'resume',
  'codex',
  'gemini',
  'acp',
  'openclaw',
  'agy',
  'logout',
  'notify',
  'daemon',
]);

export function cliInvocationDiagnostic(args: readonly string[]): {
  commandFamily: string;
  argumentCount: number;
} {
  const command = args[0];
  return {
    commandFamily: command && LOGGABLE_COMMAND_FAMILIES.has(command)
      ? command
      : 'default',
    argumentCount: args.length,
  };
}
