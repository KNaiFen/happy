import chalk from 'chalk';
import { readCredentials } from '@/persistence';
import { ApiClient } from '@/api/api';
import { authenticateCodex } from './connect/authenticateCodex';
import { decodeJwtPayload } from './connect/utils';

/**
 * Handle connect subcommand
 * 
 * Implements connect subcommands for storing Codex credentials:
 * - connect codex: Store OpenAI API key in Happy cloud
 * - connect help: Show help for connect command
 */
export async function handleConnectCommand(args: string[]): Promise<void> {
    const subcommand = args[0];

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        showConnectHelp();
        return;
    }

    switch (subcommand.toLowerCase()) {
        case 'codex':
            await handleConnectCodex();
            break;
        case 'status':
            await handleConnectStatus();
            break;
        default:
            console.error(chalk.red(`Unknown connect target: ${subcommand}`));
            showConnectHelp();
            process.exit(1);
    }
}

function showConnectHelp(): void {
    console.log(`
${chalk.bold('happy connect')} - Connect Codex credentials to Happy cloud

${chalk.bold('Usage:')}
  happy connect codex        Store your Codex API key in Happy cloud
  happy connect status       Show Codex connection status
  happy connect help         Show this help message

${chalk.bold('Description:')}
  The connect command allows you to securely store your Codex credentials
  in Happy cloud. This enables you to use Codex through Happy
  without exposing your API keys locally.

${chalk.bold('Examples:')}
  happy connect codex
  happy connect status

${chalk.bold('Notes:')} 
  • You must be authenticated with Happy first (run 'happy auth login')
  • API keys are encrypted and stored securely in Happy cloud
  • You can manage your stored keys at app.happy.engineering
`);
}

async function handleConnectCodex(): Promise<void> {
    console.log(chalk.bold('\nConnecting Codex to Happy cloud\n'));

    // Check if authenticated
    const credentials = await readCredentials();
    if (!credentials) {
        console.log(chalk.yellow('⚠️  Not authenticated with Happy'));
        console.log(chalk.gray('  Please run "happy auth login" first'));
        process.exit(1);
    }

    // Create API client
    const api = await ApiClient.create(credentials);

    const codexAuthTokens = await authenticateCodex();
    await api.registerVendorToken('openai', { oauth: codexAuthTokens });
    console.log('Codex token registered with server');
}

/**
 * Show connection status for all vendors
 */
async function handleConnectStatus(): Promise<void> {
    console.log(chalk.bold('\nCodex Connection Status\n'));

    // Check if authenticated
    const credentials = await readCredentials();
    if (!credentials) {
        console.log(chalk.yellow('⚠️  Not authenticated with Happy'));
        console.log(chalk.gray('  Please run "happy auth login" first'));
        process.exit(1);
    }

    // Create API client
    const api = await ApiClient.create(credentials);

    try {
        const token = await api.getVendorToken('openai');
            
            if (token?.oauth) {
                // Try to extract user info from id_token (JWT)
                let userInfo = '';
                
                if (token.oauth.id_token) {
                    const payload = decodeJwtPayload(token.oauth.id_token);
                    if (payload?.email) {
                        userInfo = chalk.gray(` (${payload.email})`);
                    }
                }
                
                // Check if token might be expired
                const expiresAt = token.oauth.expires_at || (token.oauth.expires_in ? Date.now() + token.oauth.expires_in * 1000 : null);
                const isExpired = expiresAt && expiresAt < Date.now();
                
                if (isExpired) {
                    console.log(`  ${chalk.yellow('!')}  OpenAI Codex: ${chalk.yellow('expired')}${userInfo}`);
                } else {
                    console.log(`  ${chalk.green('connected')}  OpenAI Codex${userInfo}`);
                }
            } else {
                console.log(`  OpenAI Codex: ${chalk.gray('not connected')}`);
            }
    } catch {
        console.log(`  OpenAI Codex: ${chalk.gray('not connected')}`);
    }

    console.log('');
    console.log(chalk.gray('To connect Codex, run: happy connect codex'));
    console.log('');
}
