export function replaceOwnedBuffer(
    buffers: Map<string, Uint8Array>,
    id: string,
    value: Uint8Array,
): Uint8Array {
    const ownedValue = value.slice();
    buffers.get(id)?.fill(0);
    buffers.set(id, ownedValue);
    return ownedValue;
}
