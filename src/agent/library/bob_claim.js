// Claim is property, not a prebuilt house or an exploration boundary.
// Server-side protection must be configured separately; this module does NOT grant permissions.
export const CLAIM = Object.freeze({
    center: Object.freeze({ x: -1144, z: 752 }),
    width: 128,
    depth: 128,
});

export function claimBounds(claim = CLAIM) {
    const { x, z } = claim.center;
    const { width, depth } = claim;
    if (![x, z, width, depth].every(Number.isInteger) || width < 1 || depth < 1) {
        throw new TypeError('Invalid claim dimensions or center');
    }
    const x1 = x - Math.floor(width / 2);
    const z1 = z - Math.floor(depth / 2);
    return Object.freeze({ x1, x2: x1 + width - 1, z1, z2: z1 + depth - 1 });
}

export function isInClaim(pos, claim = CLAIM) {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return false;
    const b = claimBounds(claim);
    return pos.x >= b.x1 && pos.x < b.x2 + 1 && pos.z >= b.z1 && pos.z < b.z2 + 1;
}

// A home is discovered only after Bob builds and verifies a real structure.
// The claim center must never be substituted for a door, bed or spawn position.
export function verifiedHomeLocation(home) {
    if (!home || home.verified !== true) return null;
    const p = home.position;
    return p && [p.x, p.y, p.z].every(Number.isFinite) ? { x:p.x, y:p.y, z:p.z } : null;
}
