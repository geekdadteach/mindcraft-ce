// [ai-player] Fix 1e: the current emergency shelter, or null.
// { day, dimension, placed: [{x,y,z,name}], dug: [{x,y,z}] }
// Kept in its own leaf module (no imports) so movement code (ai_player_nav.js) can read it without
// importing the heavier night_shelter module — that would form an import cycle.
let _shelter = null;
export function shelterState() { return _shelter; }
export function isSheltered() { return _shelter !== null; }
export function markSheltered(info = {}) {
    _shelter = { day: info.day ?? null, dimension: info.dimension ?? null, placed: info.placed ?? [], dug: info.dug ?? [] };
    return _shelter;
}
export function clearShelter() { _shelter = null; }
