// Dynamic verified home. Features exist only after they are found in the world.
// The retired hilltop is recorded for migration matching and must never be a destination.
import fs from 'fs';
import path from 'path';
import { CLAIM, isInClaim, verifiedHomeLocation } from './bob_claim.js';

export { verifiedHomeLocation };

// Retired physical house. Used only to recognize obsolete saved data.
export const LEGACY_HILLTOP = Object.freeze({
    base: Object.freeze({ x: -823, y: 124, z: 568 }),
    door: Object.freeze({ x: -820, y: 124, z: 566 }),
    entrance: Object.freeze({ x: -819.5, y: 124, z: 565.5 }),
    inside: Object.freeze({ x: -819.5, y: 124, z: 567.5 }),
    bed: Object.freeze({ x: -822, y: 124, z: 569 }),
    plateSupport: Object.freeze({ x: -820, y: 123, z: 565 }),
});
export const LEGACY_HOME_ENTRANCE = LEGACY_HILLTOP.entrance;

const OUT = {
    north: { dx: 0, dz: -1 },
    south: { dx: 0, dz: 1 },
    west: { dx: -1, dz: 0 },
    east: { dx: 1, dz: 0 },
};

export function emptyHome() {
    return {
        version: 1,
        verified: false,
        position: null,
        door: null,
        facing: null,
        entrance: null,
        inside: null,
        bed: null,
        storage: null,
        plateSupport: null,
        exitWaypoint: null,
        indoor: null,
        seedRoute: null,
        geometry: null,
        verifiedAt: null,
    };
}

function freezeHome(home) {
    if (!home) return emptyHome();
    const freezePoint = (p) => (p && [p.x, p.y, p.z].every(Number.isFinite) ? Object.freeze({ x: p.x, y: p.y, z: p.z }) : null);
    const freezeBox = (b) => (b ? Object.freeze({ ...b }) : null);
    return Object.freeze({
        version: 1,
        verified: home.verified === true,
        position: freezePoint(home.position),
        door: freezePoint(home.door),
        facing: home.facing || null,
        entrance: freezePoint(home.entrance),
        inside: freezePoint(home.inside),
        bed: freezePoint(home.bed),
        storage: freezePoint(home.storage),
        plateSupport: freezePoint(home.plateSupport),
        exitWaypoint: freezePoint(home.exitWaypoint),
        indoor: freezeBox(home.indoor),
        seedRoute: Array.isArray(home.seedRoute) ? Object.freeze(home.seedRoute.map((p) => Object.freeze([...p]))) : null,
        geometry: home.geometry
            ? Object.freeze({
                area: freezeBox(home.geometry.area),
                porch: freezeBox(home.geometry.porch),
                walkingLane: freezeBox(home.geometry.walkingLane),
            })
            : null,
        verifiedAt: home.verifiedAt ?? null,
    });
}

export function isVerifiedHome(home) {
    return !!verifiedHomeLocation(home) && !!home.door && !!home.entrance && !!home.bed && !!home.geometry;
}

export function sameHomeEntrance(a, b) {
    if (!a || !b) return false;
    return [a.x, a.y, a.z].every(Number.isFinite)
        && [b.x, b.y, b.z].every(Number.isFinite)
        && a.x === b.x && a.y === b.y && a.z === b.z;
}

export function isLegacyHilltopPos(pos, radius = 16) {
    if (!pos || ![pos.x, pos.z].every(Number.isFinite)) return false;
    const h = LEGACY_HILLTOP.base;
    return Math.hypot(pos.x - h.x, pos.z - h.z) <= radius;
}

function blockPos(p) {
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

function entityOn(block, y = block.y) {
    return { x: block.x + 0.5, y, z: block.z + 0.5 };
}

export function facingFromOutside(outsideDir) {
    if (outsideDir?.dz < 0) return 'north';
    if (outsideDir?.dz > 0) return 'south';
    if (outsideDir?.dx < 0) return 'west';
    if (outsideDir?.dx > 0) return 'east';
    return 'north';
}

// Build occupancy / protection boxes from a discovered door. Outside is the facing direction.
export function geometryFromFeatures({ door, facing = 'north', bed = null, storage = null }) {
    if (!door || ![door.x, door.y, door.z].every(Number.isFinite)) return null;
    const dir = OUT[facing] || OUT.north;
    const d = blockPos(door);
    const outside = { x: d.x + dir.dx, y: d.y, z: d.z + dir.dz };
    const insideBlk = { x: d.x - dir.dx, y: d.y, z: d.z - dir.dz };
    const perp = { dx: -dir.dz, dz: dir.dx };
    // Keep the old relative footprint: 12×8 on the ground, porch two blocks outside, lane 3 wide.
    // Area covers the interior (inward) plus the door row; porch covers two outside rows.
    const interiorCells = [];
    for (let alongI = 0; alongI <= 7; alongI++) {
        for (let side = -7; side <= 4; side++) {
            interiorCells.push({
                x: d.x - dir.dx * alongI + perp.dx * side,
                z: d.z - dir.dz * alongI + perp.dz * side,
            });
        }
    }
    const porchCells = [];
    for (let alongO = 1; alongO <= 2; alongO++) {
        for (let side = -7; side <= 4; side++) {
            porchCells.push({
                x: d.x + dir.dx * alongO + perp.dx * side,
                z: d.z + dir.dz * alongO + perp.dz * side,
            });
        }
    }
    const laneCells = [];
    for (let alongO = 1; alongO <= 2; alongO++) {
        for (let side = -1; side <= 1; side++) {
            laneCells.push({
                x: d.x + dir.dx * alongO + perp.dx * side,
                z: d.z + dir.dz * alongO + perp.dz * side,
            });
        }
    }
    const boxOf = (cells, y1, y2) => {
        const xs = cells.map((c) => c.x), zs = cells.map((c) => c.z);
        return { x1: Math.min(...xs), x2: Math.max(...xs), y1, y2, z1: Math.min(...zs), z2: Math.max(...zs) };
    };
    const area = boxOf(interiorCells, d.y - 1, d.y + 3);
    const porch = boxOf(porchCells, d.y - 1, d.y + 3);
    const walkingLane = boxOf(laneCells, d.y - 1, d.y + 2);
    const entrance = entityOn(outside, d.y);
    const inside = entityOn(insideBlk, d.y);
    const plateSupport = { x: outside.x, y: d.y - 1, z: outside.z };
    const exitBlk = { x: d.x + dir.dx * 4, y: d.y, z: d.z + dir.dz * 4 };
    const exitWaypoint = entityOn(exitBlk, d.y);
    // Indoor occupancy is the interior box, slightly inset.
    const indoorBox = {
        x1: area.x1, x2: area.x2 - (perp.dx ? 0 : 1),
        y1: d.y - 1.5, y2: d.y + 1.5,
        z1: area.z1 + (dir.dz <= 0 ? 0.8 : 0),
        z2: area.z2 - (dir.dz >= 0 ? 0 : 0),
    };
    const seedRoute = [2, 3, 4].map((n) => {
        const c = { x: d.x + dir.dx * n, z: d.z + dir.dz * n };
        return Object.freeze([c.x + 0.5, d.y - 1, c.z + 0.5]);
    }).concat([Object.freeze([entrance.x, entrance.y, entrance.z])]);

    return {
        door: { x: d.x, y: d.y, z: d.z },
        facing,
        entrance,
        inside,
        bed: bed && [bed.x, bed.y, bed.z].every(Number.isFinite) ? { x: bed.x, y: bed.y, z: bed.z } : null,
        storage: storage && [storage.x, storage.y, storage.z].every(Number.isFinite) ? { x: storage.x, y: storage.y, z: storage.z } : null,
        plateSupport,
        exitWaypoint,
        indoor: indoorBox,
        seedRoute,
        geometry: { area, porch, walkingLane },
        position: inside,
    };
}

const DOOR_RE = /_door$/;
const BED_RE = /_bed$/;
const CHEST_RE = /chest|barrel|shulker_box/;
const ROOF_RE = /planks|_log$|_wood$|stairs|slab|glass|cobblestone|stone_bricks|deepslate|bricks|copper/;

function scanBlocks(getBlock, origin, radius, test) {
    const o = blockPos(origin);
    const found = [];
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -4; dy <= 6; dy++) {
            for (let dz = -radius; dz <= radius; dz++) {
                const p = { x: o.x + dx, y: o.y + dy, z: o.z + dz };
                let block = null;
                try { block = getBlock(p.x, p.y, p.z); } catch (_) { continue; }
                const name = String(block?.name || '');
                if (test(name, p, block)) found.push({ ...p, name, block });
            }
        }
    }
    found.sort((a, b) => Math.hypot(a.x - o.x, a.y - o.y, a.z - o.z) - Math.hypot(b.x - o.x, b.y - o.y, b.z - o.z));
    return found;
}

function inferFacing(getBlock, door) {
    let best = 'north', bestAir = -1;
    for (const [name, dir] of Object.entries(OUT)) {
        const outside = { x: door.x + dir.dx, y: door.y, z: door.z + dir.dz };
        const inside = { x: door.x - dir.dx, y: door.y, z: door.z - dir.dz };
        let air = 0;
        for (const p of [outside, { ...outside, y: door.y + 1 }]) {
            let b = null;
            try { b = getBlock(p.x, p.y, p.z); } catch (_) {}
            const n = String(b?.name || 'air');
            if (n === 'air' || n === 'cave_air' || /pressure_plate/.test(n)) air += 2;
        }
        let inner = null;
        try { inner = getBlock(inside.x, inside.y, inside.z); } catch (_) {}
        const inName = String(inner?.name || 'air');
        if (inName === 'air' || inName === 'cave_air' || /pressure_plate/.test(inName)) air += 1;
        if (air > bestAir) { bestAir = air; best = name; }
    }
    return best;
}

export function discoverHomeFeatures(getBlock, origin, { radius = 16 } = {}) {
    if (!origin || typeof getBlock !== 'function') return null;
    const doors = scanBlocks(getBlock, origin, radius, (n) => DOOR_RE.test(n));
    if (!doors.length) return null;
    const door = doors[0];
    const facing = inferFacing(getBlock, door);
    const beds = scanBlocks(getBlock, door, 8, (n) => BED_RE.test(n));
    const chests = scanBlocks(getBlock, door, 8, (n) => CHEST_RE.test(n));
    return geometryFromFeatures({
        door,
        facing,
        bed: beds[0] || null,
        storage: chests[0] || null,
    });
}

function roofOver(getBlock, pos) {
    for (let y = Math.floor(pos.y) + 2; y <= Math.floor(pos.y) + 6; y++) {
        let b = null;
        try { b = getBlock(Math.floor(pos.x), y, Math.floor(pos.z)); } catch (_) { return false; }
        const n = String(b?.name || '');
        if (!n || n === 'air' || n === 'cave_air') continue;
        if (ROOF_RE.test(n) || /_door$/.test(n)) return true;
        return false;
    }
    return false;
}

export function verifyHomeInWorld(getBlock, candidate, { requireStorage = true } = {}) {
    if (!candidate || typeof getBlock !== 'function') return { ok: false, why: 'no candidate' };
    const door = candidate.door, bed = candidate.bed, entrance = candidate.entrance, inside = candidate.inside;
    if (!door || !bed || !entrance || !inside) return { ok: false, why: 'missing door, bed, entrance or interior' };
    let doorBlk = null, bedBlk = null;
    try { doorBlk = getBlock(Math.floor(door.x), Math.floor(door.y), Math.floor(door.z)); } catch (_) {}
    try { bedBlk = getBlock(Math.floor(bed.x), Math.floor(bed.y), Math.floor(bed.z)); } catch (_) {}
    if (!DOOR_RE.test(String(doorBlk?.name || ''))) return { ok: false, why: 'door is not present in the world' };
    if (!BED_RE.test(String(bedBlk?.name || ''))) return { ok: false, why: 'bed is not present in the world' };
    if (!roofOver(getBlock, inside)) return { ok: false, why: 'interior has no roof' };
    if (requireStorage) {
        const storage = candidate.storage;
        if (!storage) return { ok: false, why: 'no storage' };
        let chestBlk = null;
        try { chestBlk = getBlock(Math.floor(storage.x), Math.floor(storage.y), Math.floor(storage.z)); } catch (_) {}
        if (!CHEST_RE.test(String(chestBlk?.name || ''))) return { ok: false, why: 'storage is not present in the world' };
    }
    // Never accept the claim center as a stand-in for a house, and never the retired hilltop.
    if (Math.hypot(door.x - CLAIM.center.x, door.z - CLAIM.center.z) < 1.5 && !DOOR_RE.test(String(doorBlk?.name || '')))
        return { ok: false, why: 'claim center is not a house' };
    if (isLegacyHilltopPos(door, 12)) return { ok: false, why: 'retired hilltop is not an active home' };
    return { ok: true, why: 'ok' };
}

export function homeFromWorld(getBlock, origin, opts = {}) {
    const features = discoverHomeFeatures(getBlock, origin, opts);
    if (!features) return null;
    const check = verifyHomeInWorld(getBlock, features, opts);
    if (!check.ok) return null;
    return freezeHome({ ...emptyHome(), ...features, verified: true, verifiedAt: Date.now() });
}

let _active = freezeHome(emptyHome());
export function getActiveHome() { return _active; }
export function setActiveHome(home) {
    _active = isVerifiedHome(home) ? freezeHome(home) : freezeHome(emptyHome());
    return _active;
}

export function loadHome(file) {
    try {
        if (file && fs.existsSync(file)) {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            return freezeHome(data);
        }
    } catch (e) {
        console.warn(`[ai-player] home: load failed (${e.message})`);
    }
    return freezeHome(emptyHome());
}

export function saveHome(file, home) {
    if (!file) return false;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp.${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(home, null, 2) + '\n');
        fs.renameSync(tmp, file);
        return true;
    } catch (e) {
        console.warn(`[ai-player] home: save failed (${e.message})`);
        return false;
    }
}

export class HomeRegistry {
    constructor(agent, { file } = {}) {
        this.agent = agent;
        this.file = file || path.resolve(`bots/${agent?.name || 'MineBobNE'}/verified_home.json`);
        this.home = loadHome(this.file);
        if (isVerifiedHome(this.home) && isLegacyHilltopPos(this.home.door, 12)) {
            console.warn('[ai-player] home: refusing to load retired hilltop as a verified home');
            this.home = freezeHome(emptyHome());
        }
        setActiveHome(this.home);
    }
    snapshot() { return this.home; }
    hasHome() { return isVerifiedHome(this.home); }
    recordVerified(features) {
        if (isLegacyHilltopPos(features?.door, 12)) return false;
        const home = freezeHome({ ...emptyHome(), ...features, verified: true, verifiedAt: Date.now() });
        if (!isVerifiedHome(home)) return false;
        this.home = home;
        setActiveHome(home);
        saveHome(this.file, home);
        return true;
    }
    observeWorld(getBlock, origin) {
        const found = homeFromWorld(getBlock, origin);
        if (!found) return this.home;
        this.recordVerified(found);
        return this.home;
    }
    clear() {
        this.home = freezeHome(emptyHome());
        setActiveHome(this.home);
        saveHome(this.file, this.home);
    }
}

export function homeFileFor(agentName) {
    return path.resolve(`bots/${agentName || 'MineBobNE'}/verified_home.json`);
}

// Test/operator fixture: a verified home on the claim, never the retired hilltop.
export function exampleVerifiedHome({ door = { x: -1120, y: 68, z: 734 }, facing = 'north', bed, storage } = {}) {
    const features = geometryFromFeatures({
        door,
        facing,
        bed: bed || { x: door.x - 2, y: door.y, z: door.z + 3 },
        storage: storage || { x: door.x + 2, y: door.y, z: door.z + 3 },
    });
    return freezeHome({ ...emptyHome(), ...features, verified: true, verifiedAt: 1 });
}
