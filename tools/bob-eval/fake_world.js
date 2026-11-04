// [bob-eval] Deterministic in-memory world + bot for the offline harness. No network, no server.
import { EventEmitter } from 'node:events';
import Vec3 from 'vec3';

const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;

export class FakeWorld {
    constructor({ groundY = 63, groundBlock = 'grass_block' } = {}) {
        this.groundY = groundY;           // top solid layer; the bot stands at groundY + 1
        this.groundBlock = groundBlock;
        this.blocks = new Map();          // explicit overrides: "x,y,z" -> name ('air' allowed)
        this.sealed = [];                 // boxes the fake pathfinder cannot enter
    }
    getBlockName(x, y, z) {
        const v = this.blocks.get(key(x, y, z));
        if (v) return v;
        if (Math.floor(y) === this.groundY) return this.groundBlock;
        return Math.floor(y) < this.groundY ? 'stone' : 'air';
    }
    setBlock(x, y, z, name) { this.blocks.set(key(x, y, z), name); }
    isSolid(x, y, z) { return !/^(air|cave_air|void_air|water|lava|short_grass|tall_grass)$/.test(this.getBlockName(x, y, z)); }
    addTree(x, z, height = 4, log = 'oak_log') {
        for (let i = 1; i <= height; i++) this.setBlock(x, this.groundY + i, z, log);
    }
    // A sealed box: walls of `wall` around [min,max] and the inside unreachable for the fake pathfinder.
    addSealedBox(min, max, wall = 'bedrock') {
        for (let x = min.x - 1; x <= max.x + 1; x++)
            for (let y = min.y - 1; y <= max.y + 1; y++)
                for (let z = min.z - 1; z <= max.z + 1; z++) {
                    const inside = x >= min.x && x <= max.x && y >= min.y && y <= max.y && z >= min.z && z <= max.z;
                    this.setBlock(x, y, z, inside ? 'air' : wall);
                }
        this.sealed.push({ min, max });
    }
    isReachable(x, y, z) {
        return !this.sealed.some(({ min, max }) => x >= min.x - 1 && x <= max.x + 1 && y >= min.y - 1 && y <= max.y + 1
            && z >= min.z - 1 && z <= max.z + 1);
    }
    findBlocks(predicate, from, maxDistance = 32) {
        const out = [];
        for (const [k, name] of this.blocks) {
            if (!predicate(name)) continue;
            const [x, y, z] = k.split(',').map(Number);
            const d = Math.hypot(x - from.x, y - from.y, z - from.z);
            if (d <= maxDistance && this.isReachable(x, y, z)) out.push({ name, x, y, z, d });
        }
        return out.sort((a, b) => a.d - b.d || a.x - b.x || a.y - b.y || a.z - b.z);
    }
}

export class FakeInventory {
    constructor(initial = {}) { this.counts = new Map(Object.entries(initial)); }
    items() {
        return [...this.counts].filter(([, n]) => n > 0).map(([name, count], slot) => ({ name, count, slot, type: slot }));
    }
    count(name) { return this.counts.get(name) || 0; }
    add(name, n = 1) { this.counts.set(name, this.count(name) + n); }
    remove(name, n = 1) {
        if (this.count(name) < n) return false;
        this.counts.set(name, this.count(name) - n);
        return true;
    }
    snapshot() { return Object.fromEntries([...this.counts].filter(([, n]) => n > 0).sort()); }
}

export function createFakeBot(world, { position = { x: 0, y: 64, z: 0 }, inventory = {}, username = 'Bob' } = {}) {
    const bot = new EventEmitter();
    bot.setMaxListeners(50);
    Object.assign(bot, {
        username, health: 20, food: 20, output: '', interrupt_code: false, _actionGen: 0,
        world,
        entity: { position: new Vec3(position.x, position.y, position.z), yaw: 0, pitch: 0, velocity: new Vec3(0, 0, 0) },
        inventory: new FakeInventory(inventory),
        modes: { flushBehaviorLog: () => '', isOn: () => false, pause() {}, unpause() {} },
        pathfinder: { stop() {}, setGoal() {}, isMoving: () => false },
        pvp: { stop() {} },
        collectBlock: { cancelTask: async () => {}, targets: { empty: true, clear() {} } },
        stopDigging() {}, clearControlStates() {},
        chats: [],
        chat(msg) { bot.chats.push(String(msg)); },
        whisper(to, msg) { bot.chats.push(String(msg)); },
        blockAt(pos) {
            const name = world.getBlockName(pos.x, pos.y, pos.z);
            return { name, position: new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)),
                boundingBox: world.isSolid(pos.x, pos.y, pos.z) ? 'block' : 'empty' };
        },
        teleport(x, y, z) { bot.entity.position = new Vec3(x, y, z); },
    });
    return bot;
}
