const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    standaloneDockerDirectoryInputs,
    standaloneDockerFileInputs,
} = require('./classify-workflow-changes.cjs');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'Dockerfile.server'), 'utf8');
const dockerignore = fs.readFileSync(path.join(repositoryRoot, '.dockerignore'), 'utf8');
const workflow = fs.readFileSync(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
const relayWorkflow = fs.readFileSync(
    path.join(repositoryRoot, '.github', 'workflows', 'build-debian13-relay-release.yml'),
    'utf8',
);
const lifecycle = fs.readFileSync(
    path.join(repositoryRoot, 'scripts', 'ci', 'test-standalone-server-container.sh'),
    'utf8',
);

test('root Dockerfile builds the production standalone runtime', () => {
    assert.match(dockerfile, /pnpm --filter happy-server-self-host build/);
    assert.doesNotMatch(dockerfile, /pnpm --filter happy-server(?:\s|$)/m);
    assert.match(dockerfile, /gcr\.io\/distroless\/nodejs24-debian13:nonroot/);
    assert.match(dockerfile, /USER 65532:65532/);
    assert.match(dockerfile, /VOLUME \["\/data"\]/);
    assert.match(dockerfile, /EXPOSE 3005/);
    assert.match(
        dockerfile,
        /ENTRYPOINT \["\/nodejs\/bin\/node", "\/opt\/happy-server\/entrypoint\.mjs"\]/,
    );
    assert.doesNotMatch(dockerfile, /CMD \["pnpm"/);
});

test('Docker build context excludes environment files', () => {
    for (const required of ['.env', '.env.*', '**/.env', '**/.env.*']) {
        assert.equal(dockerignore.split(/\r?\n/).includes(required), true, required);
    }
});

test('Docker build inputs remain visible to the Server classifier', () => {
    for (const input of standaloneDockerFileInputs) {
        if (input === '.dockerignore' || input === 'Dockerfile.server') continue;
        assert.equal(dockerfile.includes(input), true, input);
    }
    for (const input of standaloneDockerDirectoryInputs) {
        assert.equal(dockerfile.includes(input.slice(0, -1)), true, input);
    }
    assert.match(workflow, /- "\.dockerignore"/);
});

test('monorepo CI routes and exercises the root standalone image', () => {
    assert.match(workflow, /- "Dockerfile\.server"/);
    assert.match(workflow, /docker build[\s\S]*--file Dockerfile\.server/);
    assert.match(
        workflow,
        /GITHUB_ACTIONS=true scripts\/ci\/test-standalone-server-container\.sh "\$IMAGE"/,
    );
});

test('cloud lifecycle covers persistence and runtime security boundaries', () => {
    for (const required of [
        'GITHUB_ACTIONS',
        '/v1/sessions/${sessionId}/attachments/request-upload',
        '/v1/sessions/${state.sessionId}/attachments/request-download',
        'docker stop "$container_name"',
        '--read-only',
        '--publish 127.0.0.1:3005:3005',
        '--cap-drop ALL',
        'no-new-privileges:true',
        '/run/secrets/happy_master_secret',
        'HANDY_MASTER_SECRET|DATABASE_URL|REDIS_URL|S3_HOST',
        'host attachment URL',
    ]) {
        assert.equal(lifecycle.includes(required), true, required);
    }
});

test('Relay source and deployment contracts fail in the required Server CI job', () => {
    for (const required of [
        'name: Build Server runtime',
        'name: Lint Debian relay deployment scripts',
        'scripts/ci/test-verify-debian13-relay-bundle.sh',
        'packages/happy-server/deploy/debian13-amd64/entrypoint.mjs',
        'scripts/ci/verify-deployed-server-runtime.mjs',
        'name: Validate Debian relay Compose configuration',
    ]) {
        assert.equal(workflow.includes(required), true, required);
    }
    assert.doesNotMatch(relayWorkflow, /^  validate:$/m);
    assert.doesNotMatch(relayWorkflow, /needs: validate/);
    for (const required of [
        'name: Verify image identity and relay-only contents',
        'name: Block Critical image vulnerabilities',
        'name: Exercise delivered installer and relay lifecycle',
    ]) {
        assert.equal(relayWorkflow.includes(required), true, required);
    }
});
