export type AnchoredMenuRect = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type AnchoredMenuPlacement = {
    left: number;
    top: number;
    width: number;
    height: number;
    maxHeight: number;
    direction: 'above' | 'below';
    alignment: 'start' | 'end';
};

export type AnchoredMenuPlacementInput = {
    anchor: AnchoredMenuRect;
    viewport: { width: number; height: number };
    menu: { width: number; height: number };
    safeArea?: { top?: number; right?: number; bottom?: number; left?: number };
    keyboardHeight?: number;
    margin?: number;
    gap?: number;
};

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

/**
 * Places a menu next to its trigger without allowing the safe-area or keyboard
 * to turn the menu into a clipped bottom sheet.
 */
export function resolveAnchoredMenuPlacement(input: AnchoredMenuPlacementInput): AnchoredMenuPlacement {
    const margin = input.margin ?? 8;
    const gap = input.gap ?? 6;
    const safeArea = {
        top: input.safeArea?.top ?? 0,
        right: input.safeArea?.right ?? 0,
        bottom: input.safeArea?.bottom ?? 0,
        left: input.safeArea?.left ?? 0,
    };
    const bounds = {
        left: safeArea.left + margin,
        right: input.viewport.width - safeArea.right - margin,
        top: safeArea.top + margin,
        bottom: input.viewport.height - safeArea.bottom - Math.max(0, input.keyboardHeight ?? 0) - margin,
    };
    const availableWidth = Math.max(0, bounds.right - bounds.left);
    const width = Math.min(Math.max(0, input.menu.width), availableWidth);
    const requestedHeight = Math.max(0, input.menu.height);
    const belowTop = input.anchor.y + input.anchor.height + gap;
    const aboveTop = input.anchor.y - requestedHeight - gap;
    const endLeft = input.anchor.x + input.anchor.width - width;
    const startLeft = input.anchor.x;

    const candidates: Array<{
        direction: 'above' | 'below';
        alignment: 'start' | 'end';
        left: number;
        top: number;
    }> = [
        { direction: 'below', alignment: 'end', left: endLeft, top: belowTop },
        { direction: 'above', alignment: 'end', left: endLeft, top: aboveTop },
        { direction: 'below', alignment: 'start', left: startLeft, top: belowTop },
        { direction: 'above', alignment: 'start', left: startLeft, top: aboveTop },
    ];

    const fittingCandidate = candidates.find((candidate) => (
        candidate.left >= bounds.left
        && candidate.left + width <= bounds.right
        && candidate.top >= bounds.top
        && candidate.top + requestedHeight <= bounds.bottom
    ));

    if (fittingCandidate) {
        return {
            ...fittingCandidate,
            left: fittingCandidate.left,
            top: fittingCandidate.top,
            width,
            height: requestedHeight,
            maxHeight: requestedHeight,
        };
    }

    const belowSpace = Math.max(0, bounds.bottom - belowTop);
    const aboveSpace = Math.max(0, input.anchor.y - gap - bounds.top);
    const direction = belowSpace >= aboveSpace ? 'below' : 'above';
    const directionSpace = direction === 'below' ? belowSpace : aboveSpace;
    const height = Math.min(requestedHeight, directionSpace);
    const rawTop = direction === 'below'
        ? belowTop
        : input.anchor.y - height - gap;
    const maxTop = Math.max(bounds.top, bounds.bottom - height);
    const left = clamp(endLeft, bounds.left, bounds.right - width);

    return {
        left,
        top: clamp(rawTop, bounds.top, maxTop),
        width,
        height,
        maxHeight: height,
        direction,
        alignment: 'end',
    };
}
