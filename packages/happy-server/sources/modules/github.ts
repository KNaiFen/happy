import { App } from "octokit";
import { Webhooks } from "@octokit/webhooks";
import type { EmitterWebhookEvent } from "@octokit/webhooks";
import { log } from "@/utils/log";
import { diagnosticHash } from "@/utils/diagnosticHash";

let app: App | null = null;
let webhooks: Webhooks | null = null;

export async function initGithub() {
    if (
        process.env.GITHUB_APP_ID &&
        process.env.GITHUB_PRIVATE_KEY &&
        process.env.GITHUB_CLIENT_ID &&
        process.env.GITHUB_CLIENT_SECRET &&
        process.env.GITHUB_REDIRECT_URI &&
        process.env.GITHUB_WEBHOOK_SECRET
    ) {
        app = new App({
            appId: process.env.GITHUB_APP_ID,
            privateKey: process.env.GITHUB_PRIVATE_KEY,
            webhooks: {
                secret: process.env.GITHUB_WEBHOOK_SECRET
            }
        });
        
        // Initialize standalone webhooks handler for type-safe event processing
        webhooks = new Webhooks({
            secret: process.env.GITHUB_WEBHOOK_SECRET
        });
        
        // Register type-safe event handlers
        registerWebhookHandlers();
    }
}

function registerWebhookHandlers() {
    if (!webhooks) return;
    
    // Type-safe handlers for specific events
    webhooks.on("push", async ({ id, name, payload }: EmitterWebhookEvent<"push">) => {
        log({ module: 'github-webhook', event: 'push', deliveryHash: diagnosticHash(id), repositoryHash: diagnosticHash(payload.repository.full_name) },
            'GitHub webhook received');
    });
    
    webhooks.on("pull_request", async ({ id, name, payload }: EmitterWebhookEvent<"pull_request">) => {
        log({ module: 'github-webhook', event: 'pull_request', deliveryHash: diagnosticHash(id), repositoryHash: diagnosticHash(payload.repository.full_name) },
            'GitHub webhook received');
    });
    
    webhooks.on("issues", async ({ id, name, payload }: EmitterWebhookEvent<"issues">) => {
        log({ module: 'github-webhook', event: 'issues', deliveryHash: diagnosticHash(id), repositoryHash: diagnosticHash(payload.repository.full_name) },
            'GitHub webhook received');
    });
    
    webhooks.on(["star.created", "star.deleted"], async ({ id, name, payload }: EmitterWebhookEvent<"star.created" | "star.deleted">) => {
        log({ module: 'github-webhook', event: 'star', deliveryHash: diagnosticHash(id), repositoryHash: diagnosticHash(payload.repository.full_name) },
            'GitHub webhook received');
    });
    
    webhooks.on("repository", async ({ id, name, payload }: EmitterWebhookEvent<"repository">) => {
        log({ module: 'github-webhook', event: 'repository', deliveryHash: diagnosticHash(id), repositoryHash: diagnosticHash(payload.repository.full_name) },
            'GitHub webhook received');
    });
    
    // Catch-all for unhandled events
    webhooks.onAny(async ({ id }: EmitterWebhookEvent) => {
        log({ module: 'github-webhook', event: 'other', deliveryHash: diagnosticHash(id) },
            'GitHub webhook received');
    });
    
    webhooks.onError(() => {
        log({ module: 'github-webhook', level: 'error', event: 'unknown', errorKind: 'handler' },
            'GitHub webhook handler failed');
    });
}

export function getWebhooks(): Webhooks | null {
    return webhooks;
}

export function getApp(): App | null {
    return app;
}
