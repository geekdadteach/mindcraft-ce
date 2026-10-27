// [ai-player] Detect being boxed in at the house: several distinct outside
// targets fail with NoPath from inside the house area in a short window.
// Scripted door-exit is attempted once; a process reset is last resort only.

import {
    HOUSE_AREA,
    HOUSE_DOOR,
    WALKING_LANE,
    inBox,
    isInsideHouseArea
} from './house_bounds.js';
import { coordCellKey, goalPosition, navConsole } from './bob_nav_memory.js';

export const ENCLOSURE_WINDOW_MS = 8 * 60_000;
export const ENCLOSURE_REQUIRED_TARGETS = 3;
export const EXIT_WAYPOINT = { x: -819.5, y: 124, z: 562.5 };

// Two-high columns on the porch and just north of the door (the sealed exit).
export const EXIT_PROBE_CELLS = [
    { x: -821, y: 124, z: 565 }, { x: -821, y: 125, z: 565 },
    { x: -820, y: 124, z: 565 }, { x: -820, y: 125, z: 565 },
    { x: -819, y: 124, z: 565 }, { x: -819, y: 125, z: 565 },
    { x: -821, y: 124, z: 564 }, { x: -821, y: 125, z: 564 },
    { x: -820, y: 124, z: 564 }, { x: -820, y: 125, z: 564 },
    { x: -819, y: 124, z: 564 }, { x: -819, y: 125, z: 564 },
    { x: -820, y: 124, z: 563 }, { x: -820, y: 125, z: 563 },
    { x: -820, y: 124, z: 562 }, { x: -820, y: 125, z: 562 },
];

const PASSABLE = /^(air|cave_air|void_air)$|pressure_plate$|_door$|fence_gate$|^torch$|^wall_torch$|^ladder$/;

const watches = new WeakMap();

export function isOutsideHouseTarget(pos) {
    if (!pos) return false;
    return !isInsideHouseArea(pos);
}

export function inspectExitBlockers(getBlock) {
    if (typeof getBlock !== 'function') return [];
    const blockers = [];
    for (const cell of EXIT_PROBE_CELLS) {
        let block = null;
        try { block = getBlock(cell.x, cell.y, cell.z); }
        catch (_) { continue; }
        const name = String(block?.name || 'unknown');
        if (PASSABLE.test(name)) continue;
        blockers.push({
            x: cell.x,
            y: cell.y,
            z: cell.z,
            name
        });
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

    record(from, target) {
        const dest = goalPosition(target) || target;
        if (!isInsideHouseArea(from) || !isOutsideHouseTarget(dest)) {
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

export function shouldRefuseOutsideGoal(bot, goal) {
    const from = bot?.entity?.position;
    const dest = goalPosition(goal);
    const watch = bot ? enclosureWatch(bot) : null;
    return !!(watch?.frozen
        && isInsideHouseArea(from)
        && isOutsideHouseTarget(dest));
}

export function describeEnclosure(blockers) {
    return `You are enclosed in the house area (${HOUSE_AREA.x1}..${HOUSE_AREA.x2} x, ${HOUSE_AREA.z1}..${HOUSE_AREA.z2} z). `
        + `Door ${HOUSE_DOOR.x} ${HOUSE_DOOR.y} ${HOUSE_DOOR.z}; walking lane `
        + `${WALKING_LANE.x1}..${WALKING_LANE.x2} x, ${WALKING_LANE.z1}..${WALKING_LANE.z2} z. `
        + `Blocking cells: ${formatBlockers(blockers)}. `
        + `Stop retrying outside coordinates.`;
}

export function logEnclosure(blockers, extra = '') {
    navConsole(`enclosure: boxed in at the house. blockers=${formatBlockers(blockers)}${extra ? ` ${extra}` : ''}`);
}

export { HOUSE_AREA, HOUSE_DOOR, WALKING_LANE, inBox, isInsideHouseArea };
