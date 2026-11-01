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
// [ai-player] Fix 1e round 3: clearing the shelter also restores the pathfinder's ability to dig when
// the caller passes the bot (death/respawn/disconnect clear the shelter without a pack-up).
export function clearShelter(bot) {
    _shelter = null;
    try { if (bot?.pathfinder?.movements) bot.pathfinder.movements.canDig = true; } catch (_) {}
}
