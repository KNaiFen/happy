export function resolveItemSubtitleLines(subtitleLines: number | undefined): number | undefined {
    if (subtitleLines === undefined || subtitleLines <= 0) {
        return undefined;
    }

    return subtitleLines;
}
