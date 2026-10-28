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

// Survey-derived guidance: advisory only, not preselected house/bed locations.
export const CLAIM_SURVEY = Object.freeze({
    biome: 'plains',
    approximateSurfaceY: 65,
    suggestedBuildArea: Object.freeze({ x1:-1144, x2:-1097, z1:720, z2:751 }),
    undergroundVoid: Object.freeze({ x1:-1118, x2:-1107, z1:763, z2:767 }),
    caveOpenings: Object.freeze([{x:-1150,z:690},{x:-1165,z:713}].map(p=>Object.freeze(p))),
    pillagerOutpost: Object.freeze({x:-1270,z:650}),
    suggestedFields: Object.freeze({x1:-1176,x2:-1129,z1:784,z2:815}),
    suggestedAnimalArea: Object.freeze({x1:-1112,x2:-1081,z1:688,z2:751}),
    pond: Object.freeze({x:-1179,z:800}),
});

export function isKnownUnsafeFoundation(pos) {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return false;
    const b=CLAIM_SURVEY.undergroundVoid;
    return pos.x>=b.x1 && pos.x<=b.x2 && pos.z>=b.z1 && pos.z<=b.z2;
}
