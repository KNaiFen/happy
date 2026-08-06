#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');
const mode = process.argv[2];
const generatedPaths = new Set([
    'docs/CATALOG.md',
    'docs/release-matrix.md',
    'docs/decisions/README.md',
    'docs/plans/README.md',
    'docs/plans/archive/README.md',
]);

if (mode !== '--write' && mode !== '--check') {
    console.error('Usage: node scripts/docs/knowledge-base.mjs --write|--check');
    process.exit(2);
}

function indexPaths() {
    return execFileSync(
        'git',
        ['ls-files', '-z', '--cached'],
        { cwd: root, encoding: 'utf8' },
    )
        .split('\0')
        .filter(Boolean)
        .sort();
}

function markdownFiles(paths) {
    return paths.filter((file) => ['.md', '.mdx'].includes(extname(file)));
}

function readIndex(relativePath) {
    try {
        return execFileSync('git', ['show', `:${relativePath}`], {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch {
        return null;
    }
}

function read(relativePath) {
    const content = readIndex(relativePath);
    if (content === null) throw new Error(`missing Git index content for ${relativePath}`);
    return content;
}

function stripFencedCode(content) {
    let fenceCharacter = null;
    let fenceLength = 0;
    return content
        .split('\n')
        .map((line) => {
            const marker = /^ {0,3}(?:>[ \t]?)*(`{3,}|~{3,})(.*)$/.exec(line);
            if (!fenceCharacter) {
                if (marker) {
                    fenceCharacter = marker[1][0];
                    fenceLength = marker[1].length;
                    return '';
                }
                return line;
            }
            if (marker
                && marker[1][0] === fenceCharacter
                && marker[1].length >= fenceLength
                && marker[2].trim() === '') {
                fenceCharacter = null;
                fenceLength = 0;
            }
            return '';
        })
        .join('\n');
}

function stripInlineCode(content, preserveContent = false) {
    let delimiterLength = 0;
    let output = '';
    for (let index = 0; index < content.length; index += 1) {
        if (content[index] === '`') {
            let end = index;
            while (content[end] === '`') end += 1;
            const length = end - index;
            if (!delimiterLength) delimiterLength = length;
            else if (length === delimiterLength) delimiterLength = 0;
            index = end - 1;
            continue;
        }
        if (!delimiterLength || preserveContent) output += content[index];
        else if (content[index] === '\n') output += '\n';
    }
    return output;
}

function contentWithoutFencesAndComments(content) {
    return stripFencedCode(content).replace(/<!--[\s\S]*?-->/g, '');
}

function semanticContent(content) {
    return stripInlineCode(contentWithoutFencesAndComments(content));
}

function headingContent(content) {
    return stripInlineCode(contentWithoutFencesAndComments(content), true);
}

function normalizeTitle(value) {
    return value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function titleFromContent(content, fallback) {
    const visible = headingContent(content);
    const markdown = /^#\s+(.+)$/m.exec(visible);
    const html = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(visible);
    const setext = /^(.+?)\n {0,3}(?:=+|-+)\s*$/m.exec(visible);
    const candidates = [
        markdown && { index: markdown.index, value: markdown[1] },
        html && { index: html.index, value: html[1] },
        setext && { index: setext.index, value: setext[1] },
    ].filter(Boolean).sort((left, right) => left.index - right.index);
    return candidates.length ? normalizeTitle(candidates[0].value) : fallback;
}

function title(relativePath) {
    return titleFromContent(read(relativePath), relativePath);
}

function markdownLink(label, relativePath) {
    return `- [${label}](${relativePath})`;
}

function category(relativePath) {
    if (relativePath.startsWith('docs/decisions/')) return '决策记录（ADR）';
    if (relativePath.startsWith('docs/plans/archive/')) return '计划归档';
    if (relativePath.startsWith('docs/plans/')) return '活动计划';
    if (relativePath.startsWith('docs/archive/')) return '通用历史归档';
    if (relativePath.startsWith('docs/reviews/archive/')) return '审查归档';
    if (relativePath.startsWith('docs/reviews/')) return '审查记录';
    if (relativePath.startsWith('docs/research/archive/')) return '研究归档';
    if (relativePath.startsWith('docs/research/')) return '研究';
    if (relativePath.startsWith('docs/competition/')) return '竞品研究';
    if (relativePath.startsWith('docs/')) return '当前工程文档';
    if (relativePath.startsWith('packages/')) return '包级文档';
    return '仓库文档';
}

function relativeLink(from, to) {
    const value = relative(dirname(from), to).replaceAll('\\', '/');
    return value.startsWith('.') ? value : `./${value}`;
}

function makeCatalog(files) {
    const groups = new Map();
    for (const file of files.filter((file) => !generatedPaths.has(file))) {
        const key = category(file);
        const entries = groups.get(key) ?? [];
        entries.push(file);
        groups.set(key, entries);
    }

    const orderedCategories = [
        '当前工程文档',
        '决策记录（ADR）',
        '活动计划',
        '审查记录',
        '研究',
        '竞品研究',
        '包级文档',
        '仓库文档',
        '计划归档',
        '通用历史归档',
        '审查归档',
        '研究归档',
    ];
    const lines = [
        '# 文档总目录',
        '',
        '> 此文件由 `node scripts/docs/knowledge-base.mjs --write` 生成。不要手工编辑。',
        '',
        '本目录枚举 Git 索引中的 Markdown/MDX 文档（已跟踪或已暂存；不含其他生成索引）。',
        '权威性、生命周期和维护规则见 [知识库说明](knowledge-base.md)。',
        '',
    ];

    for (const key of orderedCategories) {
        const entries = groups.get(key);
        if (!entries?.length) continue;
        lines.push(`## ${key}`, '');
        for (const file of entries) {
            lines.push(markdownLink(title(file), relativeLink('docs/CATALOG.md', file)));
        }
        lines.push('');
    }
    return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function packageVersion(relativePath) {
    const pkg = JSON.parse(read(relativePath));
    return { name: pkg.name, version: pkg.version };
}

function makeReleaseMatrix() {
    const cli = packageVersion('packages/happy-cli/package.json');
    const app = packageVersion('packages/happy-app/package.json');
    const server = packageVersion('packages/happy-server/package.json');
    const agent = packageVersion('packages/happy-agent/package.json');
    const wire = packageVersion('packages/happy-wire/package.json');
    return `# 发行矩阵

> 此文件由 \`node scripts/docs/knowledge-base.mjs --write\` 生成。不要手工编辑。版本来自各包的 \`package.json\`。

| 可分发包 | 当前版本 | 云端工作流 | 产物 | 触发条件 |
| --- | ---: | --- | --- | --- |
| \`${cli.name}\` | \`${cli.version}\` | [CLI package](../.github/workflows/build-cli-release.yml) | \`happy-${cli.version}.tgz\` | \`packages/happy-cli/package.json\` 版本变更 |
| \`${app.name}\`（Android） | \`${app.version}\` | [Android APK](../.github/workflows/build-android-release.yml) | \`happy-app-${app.version}-android-arm64-v8a-no-ota.apk\` | \`packages/happy-app/package.json\` 版本变更 |
| \`${server.name}\`（Debian Relay） | \`${server.version}\` | [Debian 13 relay](../.github/workflows/build-debian13-relay-release.yml) | \`happy-relay-server-${server.version}-debian13-amd64.tar.gz\` | \`packages/happy-server/package.json\` 版本变更 |
| \`${agent.name}\` | \`${agent.version}\` | [happy-agent package](../.github/workflows/build-happy-agent-release.yml) | \`happy-agent-${agent.version}.tgz\` | \`packages/happy-agent/package.json\` 版本变更 |
| \`${wire.name}\` | \`${wire.version}\` | 由消费者工作流构建和校验 | 共享内部依赖，不单独发布 | Wire 或消费者变更 |

所有包的发布构建仅在 GitHub Actions 运行；本地例行验证保持源码级。完整流程见 [发布知识](knowledge-base.md#发布与制品)。
`;
}

function listMarkdown(files, directory) {
    const prefix = `${directory}/`;
    return files.filter((file) => file.startsWith(prefix));
}

function makeDecisionIndex(markdown) {
    const files = listMarkdown(markdown, 'docs/decisions').filter((file) => file !== 'docs/decisions/README.md');
    return [
        '# 架构决策记录',
        '',
        '> 此文件由 `node scripts/docs/knowledge-base.mjs --write` 生成。不要手工编辑。',
        '',
        'ADR 记录长期有效的架构取舍；如与代码冲突，以较新的 ADR 和当前实现为准，并在 ADR 中写明替代关系。',
        '',
        ...files.map((file) => markdownLink(title(file), relativeLink('docs/decisions/README.md', file))),
        '',
    ].join('\n');
}

function makePlanIndex(markdown, directory, outputPath, heading, intro) {
    const files = listMarkdown(markdown, directory).filter((file) =>
        file !== outputPath
        && (directory !== 'docs/plans' || !file.startsWith('docs/plans/archive/')),
    );
    const entries = files.map((file) => markdownLink(title(file), relativeLink(outputPath, file)));
    return [
        `# ${heading}`,
        '',
        '> 此文件由 `node scripts/docs/knowledge-base.mjs --write` 生成。不要手工编辑。',
        '',
        intro,
        ...(entries.length ? ['', ...entries] : []),
        '',
    ].join('\n');
}

function decodeTarget(target) {
    try {
        return decodeURIComponent(target);
    } catch {
        return target;
    }
}

function resolveLocalTarget(sourcePath, target) {
    const cleanTarget = decodeTarget(target.replace(/^<|>$/g, '').replace(/\\([\\()[\]<> ])/g, '$1'));
    if (!cleanTarget || cleanTarget.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(cleanTarget)) return null;
    if (/^\/(?:Users|home|tmp|absolute)\//.test(cleanTarget) || /:\d+(?::\d+)?$/.test(cleanTarget)) return null;

    const hashIndex = cleanTarget.indexOf('#');
    const pathAndQuery = hashIndex >= 0 ? cleanTarget.slice(0, hashIndex) : cleanTarget;
    const anchor = hashIndex >= 0 ? cleanTarget.slice(hashIndex + 1) : '';
    const pathPart = pathAndQuery.split('?', 1)[0];
    const absolute = pathPart
        ? (pathPart.startsWith('/') ? join(root, pathPart.slice(1)) : resolve(dirname(join(root, sourcePath)), pathPart))
        : join(root, sourcePath);
    const insideRepository = absolute === root || absolute.startsWith(`${root}${sep}`);
    return { absolute, anchor, insideRepository };
}

function anchorsFromContent(source) {
    const anchors = new Set();
    const counts = new Map();
    const addHeading = (value) => {
        const base = value
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
            .replace(/<[^>]+>/g, '')
            .replace(/[`*_~]/g, '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s_-]/gu, '')
            .trim()
            .replace(/\s+/g, '-');
        if (!base) return;
        const count = counts.get(base) ?? 0;
        anchors.add(count === 0 ? base : `${base}-${count}`);
        counts.set(base, count + 1);
    };
    const content = headingContent(source);
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
        const atx = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[index]);
        if (atx) {
            addHeading(atx[1]);
            continue;
        }
        if (lines[index].trim() && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1] ?? '')) {
            addHeading(lines[index]);
            index += 1;
        }
    }
    for (const match of content.matchAll(/<(?:a|span)\b[^>]*?\b(?:id|name)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/gi)) {
        anchors.add((match[1] ?? match[2] ?? match[3]).toLowerCase());
    }
    return anchors;
}

function headingAnchors(relativePath) {
    return anchorsFromContent(read(relativePath));
}

function parseDestination(content, start) {
    let index = start;
    while (/\s/.test(content[index] ?? '')) index += 1;
    if (content[index] === '<') {
        let value = '';
        for (index += 1; index < content.length; index += 1) {
            if (content[index] === '\\' && index + 1 < content.length) {
                value += content[index + 1];
                index += 1;
            } else if (content[index] === '>') {
                return { target: value, end: index + 1 };
            } else {
                value += content[index];
            }
        }
        return null;
    }

    let depth = 0;
    let value = '';
    for (; index < content.length; index += 1) {
        const character = content[index];
        if (character === '\\' && index + 1 < content.length) {
            value += content[index + 1];
            index += 1;
        } else if (character === '(') {
            depth += 1;
            value += character;
        } else if (character === ')') {
            if (depth === 0) return { target: value, end: index + 1 };
            depth -= 1;
            value += character;
        } else if (/\s/.test(character) && depth === 0) {
            return { target: value, end: index };
        } else {
            value += character;
        }
    }
    return value ? { target: value, end: index } : null;
}

function linkTargets(content) {
    const visible = semanticContent(content);
    const targets = [];
    for (let index = 0; index < visible.length - 1; index += 1) {
        if (visible[index] !== ']' || visible[index + 1] !== '(') continue;
        const parsed = parseDestination(visible, index + 2);
        if (parsed?.target) targets.push(parsed.target);
        if (parsed) index = parsed.end - 1;
    }
    for (const match of visible.matchAll(/^\s{0,3}\[[^\]^][^\]]*\]:\s*/gm)) {
        const parsed = parseDestination(visible, match.index + match[0].length);
        if (parsed?.target) targets.push(parsed.target);
    }
    for (const match of visible.matchAll(/<(?:a|img)\b[^>]*?\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
        const target = match[1] ?? match[2] ?? match[3];
        if (target) targets.push(target);
    }
    return targets;
}

function validateLinks(files, indexedPaths) {
    const failures = [];
    const anchorCache = new Map();
    const validateTarget = (file, rawTarget) => {
        const target = resolveLocalTarget(file, rawTarget);
        if (!target) return;
        if (!target.insideRepository) {
            failures.push(`${file}: local link escapes repository ${rawTarget}`);
            return;
        }
        const targetPath = relative(root, target.absolute).replaceAll('\\', '/');
        const existsInIndex = targetPath === ''
            || indexedPaths.has(targetPath)
            || [...indexedPaths].some((path) => path.startsWith(`${targetPath}/`));
        if (!existsInIndex) {
            failures.push(`${file}: missing local link ${rawTarget}`);
            return;
        }
        if (!target.anchor || /^L\d+(?:-L\d+)?$/i.test(target.anchor)) return;
        if (!['.md', '.mdx'].includes(extname(targetPath))) return;
        const anchors = anchorCache.get(targetPath) ?? headingAnchors(targetPath);
        anchorCache.set(targetPath, anchors);
        const anchor = target.anchor.toLowerCase().replace(/^user-content-/, '');
        if (!anchors.has(anchor)) {
            failures.push(`${file}: missing anchor #${target.anchor} in ${targetPath}`);
        }
    };

    for (const file of files) {
        for (const target of linkTargets(read(file))) validateTarget(file, target);
    }
    return failures;
}

function runSelfTests() {
    const failures = [];
    const expect = (condition, message) => {
        if (!condition) failures.push(`knowledge-base self-test: ${message}`);
    };
    expect(titleFromContent('```bash\n# wrong\n```\n# Right', 'fallback') === 'Right', 'fenced code must not provide a title');
    expect(titleFromContent('<h1 class="hero">\n  HTML Title\n</h1>', 'fallback') === 'HTML Title', 'HTML h1 must provide a title');
    expect(titleFromContent('# `happy server` — bundle', 'fallback') === 'happy server — bundle', 'inline code text must remain in titles');
    const targets = linkTargets('[nested](docs/a(b).md)\n<a href="../linked.md">x</a>\n<a href=plain.md>x</a>\n> ```md\n> [ignored](missing.md)\n> ```\n`[inline](inline.md)`\n<!-- [comment](comment.md) -->');
    expect(targets.includes('docs/a(b).md'), 'balanced parentheses must remain in link destinations');
    expect(targets.includes('../linked.md'), 'HTML href targets must be checked');
    expect(targets.includes('plain.md'), 'unquoted HTML href targets must be checked');
    expect(!targets.includes('missing.md'), 'fenced links must be ignored');
    expect(!targets.includes('inline.md') && !targets.includes('comment.md'), 'inline code and comments must be ignored');
    expect(anchorsFromContent('<a class="x" id="section"></a>').has('section'), 'explicit anchors may follow other attributes');
    expect(anchorsFromContent('Setext heading\n--------------').has('setext-heading'), 'Setext headings must provide anchors');
    expect(planStatusKind('## 状态\n\n- 负责人：Docs\n- 当前状态：已完成') === 'terminal', 'terminal status may follow metadata');
    expect(planStatusKind('## 状态\n\n- 当前状态：活动；真实性核验已完成') === 'active', 'completed subtasks must not close an active plan');
    expect(!makePlanIndex([], 'docs/plans', 'docs/plans/README.md', '活动计划', 'intro').endsWith('\n\n'), 'empty plan indexes must not end with a blank line');
    return failures;
}

function planStatusKind(content) {
    const heading = /^##\s+(状态|Status)(?:\s*[:：]\s*(.*))?\s*$/im.exec(content);
    if (!heading) return 'missing-section';
    const afterHeading = content.slice(heading.index + heading[0].length);
    const nextHeading = /^##\s+/m.exec(afterHeading);
    const body = afterHeading.slice(0, nextHeading?.index ?? afterHeading.length);
    const values = [];
    if (heading[2]?.trim()) values.push(heading[2].trim());
    for (const line of body.split('\n')) {
        const cleaned = line.trim().replace(/^[-*]\s+/, '');
        const declaration = /^(?:(?:当前)?状态|status)\s*[:：]\s*(.+)$/i.exec(cleaned);
        if (declaration) values.push(declaration[1].trim());
        else if (/^(?:活动|进行中|未完成|待处理|待修复|计划中|阻塞|等待|active|in progress|pending|planned|blocked|open)$/i.test(cleaned)) values.push(cleaned);
    }
    if (!values.length) return 'missing-value';
    const classify = (value) => {
        if (/^(?:已完成|已归档|废弃|已取消|已关闭|已解决|completed\b|complete\b|archived\b|superseded\b|cancelled\b|canceled\b|closed\b|resolved\b|done\b|finished\b)/i.test(value)) return 'terminal';
        if (/^(?:活动|进行中|未完成|尚未|待处理|待修复|计划中|阻塞|等待|active\b|in progress\b|pending\b|planned\b|blocked\b|open\b)/i.test(value)) return 'active';
        if (/(?:未完成|尚未|待处理|待修复|计划中|阻塞|等待|\b(?:active|in progress|pending|planned|blocked|open)\b)/i.test(value)) return 'active';
        if (/(?:已完成|已归档|废弃|已取消|已关闭|已解决|\b(?:completed|complete|archived|superseded|cancelled|canceled|closed|resolved|done|finished)\b)/i.test(value)) return 'terminal';
        return 'unknown';
    };
    const kinds = values.map(classify);
    if (kinds.includes('terminal')) return 'terminal';
    if (kinds.includes('active')) return 'active';
    return 'unknown';
}

function validateActivePlans(files) {
    const failures = [];
    for (const file of listMarkdown(files, 'docs/plans').filter((file) => !file.startsWith('docs/plans/archive/') && file !== 'docs/plans/README.md')) {
        const kind = planStatusKind(read(file));
        if (kind === 'missing-section') {
            failures.push(`${file}: active plan must declare a 状态/Status section`);
        } else if (kind === 'missing-value' || kind === 'unknown') {
            failures.push(`${file}: active plan must use an explicit active status value`);
        } else if (kind === 'terminal') {
            failures.push(`${file}: completed or archived plan is still in the active plans directory`);
        }
    }
    return failures;
}

function writeOrCheck(relativePath, expected, failures) {
    const absolute = join(root, relativePath);
    const actual = readIndex(relativePath);
    if (actual === expected) return;
    if (mode === '--write') {
        writeFileSync(absolute, expected);
        console.log(`updated ${relativePath}`);
    } else {
        failures.push(`${relativePath}: generated content is stale; run node scripts/docs/knowledge-base.mjs --write`);
    }
}

const paths = indexPaths();
const indexedPaths = new Set(paths);
const files = markdownFiles(paths);
const failures = runSelfTests();
const outputs = new Map([
    ['docs/CATALOG.md', makeCatalog(files)],
    ['docs/release-matrix.md', makeReleaseMatrix()],
    ['docs/decisions/README.md', makeDecisionIndex(files)],
    ['docs/plans/README.md', makePlanIndex(files, 'docs/plans', 'docs/plans/README.md', '活动计划', '这里只保留尚未完成且有明确下一步的实施计划。完成、取消或被替代的计划必须移入 [归档](archive/README.md)。')],
    ['docs/plans/archive/README.md', makePlanIndex(files, 'docs/plans/archive', 'docs/plans/archive/README.md', '计划归档', '这里保存已完成、取消或被替代的计划。归档保留决策与验收证据，但不代表当前路线图。')],
]);

for (const [file, content] of outputs) writeOrCheck(file, content, failures);
failures.push(...validateLinks(files, indexedPaths));
failures.push(...validateActivePlans(files));

if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
}

console.log(`knowledge base check passed for ${files.length} Markdown/MDX files`);
