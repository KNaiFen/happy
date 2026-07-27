export function parseToolUserInputAnswers(value: unknown): Record<string, string[]> {
    const response = record(value);
    const answers = record(response.answers);
    const parsed: Record<string, string[]> = {};
    for (const [questionId, answer] of Object.entries(answers)) {
        const values = record(answer).answers;
        if (!Array.isArray(values) || !values.every((entry) => typeof entry === 'string')) continue;
        parsed[questionId] = values;
    }
    return parsed;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}
