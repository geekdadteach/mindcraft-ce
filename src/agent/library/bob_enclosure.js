// Detect being boxed in at a verified house. With no verified home this is inert.

import { getActiveHome, isVerifiedHome } from './bob_home.js';
import {
    houseArea,
    houseDoor,
    walkingLane,
    inBox,
    isInsideHouseArea
} from './house_bounds.js';
import { coordCellKey, goalPosition, navConsole } from './bob_nav_memory.js';

export const ENCLOSURE_WINDOW_MS = 8 * 60_000;
export const ENCLOSURE_REQUIRED_TARGETS = 3;

export function exitWaypoint(home = getActiveHome()) {
    return isVerifiedHome(home) ? home.exitWaypoint : null;
}
export const EXIT_WAYPOINT = { get x() { return exitWaypoint()?.x ?? null; }, get y() { return exitWaypoint()?.y ?? null; }, get z() { return exitWaypoint()?.z ?? null; } };

export function exitProbeCells(home = getActiveHome()) {
    const door = houseDoor(home);
    if (!door) return [];
    const facing = home.facing || 'north';
    const out = { north: { dx: 0, dz: -1 }, south: { dx: 0, dz: 1 }, west: { dx: -1, dz: 0 }, east: { dx: 1, dz: 0 } }[facing];
    const cells = [];
    for (const dist of [1, 2]) {
        for (const side of [-1, 0, 1]) {
            const px = -out.dz, pz = out.dx;
            for (const dy of [0, 1]) {
                cells.push({
                    x: door.x + out.dx * dist + px * side,
                    y: door.y + dy,
                    z: door.z + out.dz * dist + pz * side,
                });
            }
        }
    }
    for (const dist of [3, 4]) {
        for (const dy of [0, 1]) {
            cells.push({ x: door.x + out.dx * dist, y: door.y + dy, z: door.z + out.dz * dist });
        }
    }
    return Object.freeze(cells);
}
export const EXIT_PROBE_CELLS = { [Symbol.iterator]: function* () { yield* exitProbeCells(); } };

const PASSABLE = /^(air|cave_air|void_air)$|pressure_plate$|_door$|fence_gate$|^torch$|^wall_torch$|^ladder$/;

const watches = new WeakMap();

export function isOutsideHouseTarget(pos, home = getActiveHome()) {
    if (!pos || !isVerifiedHome(home)) return false;
    return !isInsideHouseArea(pos, home);
}

export function inspectExitBlockers(getBlock, home = getActiveHome()) {
    if (typeof getBlock !== 'function' || !isVerifiedHome(home)) return [];
    const blockers = [];
    for (const cell of exitProbeCells(home)) {
        let block = null;
        try { block = getBlock(cell.x, cell.y, cell.z); }
        catch (_) { continue; }
        const name = String(block?.name || 'unknown');
        if (PASSABLE.test(name)) continue;
        blockers.push({ x: cell.x, y: cell.y, z: cell.z, name });
    }
    return blockers;
}

export function formatBlockers(blockers) {
    if (!blockers?.length) return 'none visible around the door lane';
    return blockers.map((b) => `${b.name} at ${b.x} ${b.y} ${b.z}`).join(', ');
}

export class EnclosureWatch {
    constructor({
        now = Date.now,
        windowMs = ENCLOSURE_WINDOW_MS,
        requiredTargets = ENCLOSURE_REQUIRED_TARGETS
    } = {}) {
        this.now = now;
        this.windowMs = windowMs;
        this.requiredTargets = requiredTargets;
        this.targets = new Map();
        this.enclosed = false;
        this.exitAttempted = false;
        this.frozen = false;
        this.lastBlockers = [];
    }

    _expire() {
        const now = this.now();
        for (const [key, at] of this.targets) {
            if (now - at >= this.windowMs || now < at)
                this.targets.delete(key);
        }
    }

    record(from, target, home = getActiveHome()) {
        if (!isVerifiedHome(home)) {
            return { enclosed: false, recorded: false, reason: 'no_verified_home', distinctTargets: 0 };
        }
        const dest = goalPosition(target) || target;
        if (!isInsideHouseArea(from, home) || !isOutsideHouseTarget(dest, home)) {
            return {
                enclosed: this.enclosed,
                recorded: false,
                reason: 'not_inside_to_outside',
                distinctTargets: this.targets.size
            };
        }

        const key = coordCellKey(dest.x, dest.y, dest.z);
        if (!key) {
            return {
                enclosed: this.enclosed,
                recorded: false,
                reason: 'unidentified_target',
                distinctTargets: this.targets.size
            };
        }

        this._expire();
        const now = this.now();
        if (!this.targets.has(key))
            this.targets.set(key, now);

        if (!this.enclosed && this.targets.size >= this.requiredTargets) {
            this.enclosed = true;
        }

        return {
            enclosed: this.enclosed,
            recorded: true,
            reason: this.enclosed ? 'enclosed' : 'insufficient_distinct_targets',
            distinctTargets: this.targets.size
        };
    }

    markExitAttempted() {
        this.exitAttempted = true;
    }

    freeze() {
        this.frozen = true;
        this.enclosed = true;
        this.exitAttempted = true;
    }

    clear() {
        this.targets.clear();
        this.enclosed = false;
        this.exitAttempted = false;
        this.frozen = false;
        this.lastBlockers = [];
    }
}

export function enclosureWatch(bot, opts) {
    if (!bot) throw new TypeError('bot is required');
    let watch = watches.get(bot);
    if (!watch) {
        watch = new EnclosureWatch(opts);
        watches.set(bot, watch);
    }
    return watch;
}

export function shouldRefuseOutsideGoal(bot, goal, home = getActiveHome()) {
    const from = bot?.entity?.position;
    const dest = goalPosition(goal);
    const watch = bot ? enclosureWatch(bot) : null;
    return !!(watch?.frozen
        && isVerifiedHome(home)
        && isInsideHouseArea(from, home)
        && isOutsideHouseTarget(dest, home));
}

export function describeEnclosure(blockers, home = getActiveHome()) {
    const area = houseArea(home);
    const door = houseDoor(home);
    const lane = walkingLane(home);
    if (!area || !door || !lane) return 'No verified house to be enclosed in.';
    return `You are enclosed in the house area (${area.x1}..${area.x2} x, ${area.z1}..${area.z2} z). `
        + `Door ${door.x} ${door.y} ${door.z}; walking lane `
        + `${lane.x1}..${lane.x2} x, ${lane.z1}..${lane.z2} z. `
        + `Blocking cells: ${formatBlockers(blockers)}. `
        + `Stop retrying outside coordinates.`;
}

export function logEnclosure(blockers, extra = '') {
    navConsole(`enclosure: boxed in at the house. blockers=${formatBlockers(blockers)}${extra ? ` ${extra}` : ''}`);
}

export { houseArea, houseDoor, walkingLane, inBox, isInsideHouseArea };
export { HOUSE_AREA, HOUSE_DOOR, WALKING_LANE } from './house_bounds.js';
