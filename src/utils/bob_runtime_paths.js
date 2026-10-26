import { join, isAbsolute } from 'node:path';

// The Mac uses Bob's configured runtime directory.
// Preserve the original Linux default if used there.
export function bobRuntimeRoot() {
    const root = process.env.BOB_RUNTIME_DIR ||
        (process.platform === 'darwin'
            ? process.cwd()
            : '/home/dad/ai-player');

    if (!isAbsolute(root))
        throw new Error('BOB_RUNTIME_DIR must be absolute');

    return root;
}

export function bobRuntimePath(...segments) {
    for (const segment of segments) {
        if (typeof segment !== 'string' ||
            !segment ||
            segment === '..' ||
            segment.includes('\0') ||
            segment.includes('/') ||
            segment.includes(String.fromCharCode(92)) ||
            isAbsolute(segment)) {
            throw new Error('Invalid Bob runtime path segment');
        }
    }

    return join(bobRuntimeRoot(), ...segments);
}
