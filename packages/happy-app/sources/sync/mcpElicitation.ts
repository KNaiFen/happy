export type McpElicitationField = {
    key: string;
    title: string;
    description: string | null;
    kind: 'text' | 'number' | 'integer' | 'boolean' | 'single' | 'multi';
    required: boolean;
    options: Array<{ value: string; label: string }>;
    defaultValue: string | boolean | string[];
    min: number | null;
    max: number | null;
};

export type ParsedMcpElicitation =
    | { mode: 'form'; message: string; fields: McpElicitationField[] }
    | { mode: 'json'; message: string; initialJson: string }
    | { mode: 'url'; message: string; url: string };

export type McpElicitationValues = Record<string, string | boolean | string[]>;

export type McpElicitationResponse = {
    action: 'accept' | 'decline' | 'cancel';
    content: unknown;
};

export function isMcpElicitationInput(value: unknown): boolean {
    return record(value).requestMethod === 'mcpServer/elicitation/request';
}

export function parseMcpElicitation(value: unknown): ParsedMcpElicitation | null {
    const input = record(value);
    if (input.requestMethod !== 'mcpServer/elicitation/request') return null;
    const message = typeof input.message === 'string' ? input.message : '';
    if (input.mode === 'url') {
        const url = safeExternalUrl(input.url);
        return url ? { mode: 'url', message, url } : null;
    }

    const schema = record(input.requestedSchema);
    const hasProperties = Boolean(schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties));
    const properties = record(schema.properties);
    const required = new Set(
        Array.isArray(schema.required)
            ? schema.required.filter((entry): entry is string => typeof entry === 'string')
            : [],
    );
    const fields = Object.entries(properties)
        .map(([key, property]) => parseField(key, property, required.has(key)))
        .filter((field): field is McpElicitationField => field !== null);
    if (input.mode === 'form'
        || (input.mode === 'openai/form' && hasProperties && fields.length === Object.keys(properties).length)) {
        return { mode: 'form', message, fields };
    }
    if (input.mode === 'openai/form') {
        const defaults = Object.fromEntries(fields.map((field) => [field.key, serializedDefault(field)]));
        return { mode: 'json', message, initialJson: JSON.stringify(defaults, null, 2) };
    }
    return null;
}

export function initialMcpElicitationValues(fields: McpElicitationField[]): McpElicitationValues {
    return Object.fromEntries(fields.map((field) => [field.key, field.defaultValue]));
}

export function serializeMcpElicitationValues(
    fields: McpElicitationField[],
    values: McpElicitationValues,
): Record<string, unknown> | null {
    const content: Record<string, unknown> = {};
    for (const field of fields) {
        const value = values[field.key];
        if (field.kind === 'boolean') {
            if (typeof value !== 'boolean') return null;
            content[field.key] = value;
            continue;
        }
        if (field.kind === 'multi') {
            if (!Array.isArray(value)) return null;
            if (field.required && value.length === 0) return null;
            if (field.min !== null && value.length < field.min) return null;
            if (field.max !== null && value.length > field.max) return null;
            if (value.length > 0 || field.required) content[field.key] = value;
            continue;
        }
        if (typeof value !== 'string') return null;
        if (!value && !field.required) continue;
        if (!value) return null;
        if (field.kind === 'number' || field.kind === 'integer') {
            const number = Number(value);
            if (!Number.isFinite(number) || (field.kind === 'integer' && !Number.isInteger(number))) return null;
            if (field.min !== null && number < field.min) return null;
            if (field.max !== null && number > field.max) return null;
            content[field.key] = number;
            continue;
        }
        if (field.kind === 'single' && !field.options.some((option) => option.value === value)) return null;
        if (field.min !== null && value.length < field.min) return null;
        if (field.max !== null && value.length > field.max) return null;
        content[field.key] = value;
    }
    return content;
}

export function parseMcpElicitationJson(value: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

export function parseMcpElicitationResponse(value: unknown): McpElicitationResponse | null {
    const response = record(value);
    const action = response.action;
    if (action !== 'accept' && action !== 'decline' && action !== 'cancel') return null;
    return { action, content: response.content ?? null };
}

export function formatMcpElicitationValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '-';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return '-';
    }
}

function parseField(key: string, value: unknown, required: boolean): McpElicitationField | null {
    const schema = record(value);
    const title = typeof schema.title === 'string' && schema.title.length > 0 ? schema.title : key;
    const description = typeof schema.description === 'string' ? schema.description : null;
    const base = { key, title, description, required };
    if (schema.type === 'boolean') {
        return {
            ...base,
            kind: 'boolean',
            options: [],
            defaultValue: schema.default === true,
            min: null,
            max: null,
        };
    }
    if (schema.type === 'number' || schema.type === 'integer') {
        return {
            ...base,
            kind: schema.type,
            options: [],
            defaultValue: typeof schema.default === 'number' ? String(schema.default) : '',
            min: finiteNumber(schema.minimum),
            max: finiteNumber(schema.maximum),
        };
    }
    if (schema.type === 'array') {
        const options = enumOptions(record(schema.items));
        if (options.length === 0) return null;
        return {
            ...base,
            kind: 'multi',
            options,
            defaultValue: stringArray(schema.default),
            min: finiteNumber(schema.minItems),
            max: finiteNumber(schema.maxItems),
        };
    }
    if (schema.type !== 'string') return null;
    const options = enumOptions(schema);
    return {
        ...base,
        kind: options.length > 0 ? 'single' : 'text',
        options,
        defaultValue: typeof schema.default === 'string' ? schema.default : '',
        min: finiteNumber(schema.minLength),
        max: finiteNumber(schema.maxLength),
    };
}

function enumOptions(schema: Record<string, unknown>): Array<{ value: string; label: string }> {
    if (Array.isArray(schema.oneOf)) return titledOptions(schema.oneOf);
    if (Array.isArray(schema.anyOf)) return titledOptions(schema.anyOf);
    if (!Array.isArray(schema.enum)) return [];
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.flatMap((entry, index) => typeof entry === 'string'
        ? [{ value: entry, label: typeof names[index] === 'string' ? names[index] : entry }]
        : []);
}

function titledOptions(values: unknown[]): Array<{ value: string; label: string }> {
    return values.flatMap((entry) => {
        const option = record(entry);
        return typeof option.const === 'string'
            ? [{ value: option.const, label: typeof option.title === 'string' ? option.title : option.const }]
            : [];
    });
}

function serializedDefault(field: McpElicitationField): unknown {
    if (field.kind === 'number' || field.kind === 'integer') {
        return field.defaultValue === '' ? null : Number(field.defaultValue);
    }
    return field.defaultValue;
}

function safeExternalUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
    } catch {
        return null;
    }
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
