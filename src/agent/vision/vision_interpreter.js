import { Vec3 } from 'vec3';
import { Camera } from "./camera.js";
import fs from 'fs';
import path from 'path';

export class VisionInterpreter {
    constructor(agent, allow_vision) {
        this.agent = agent;
        this.allow_vision = allow_vision;
        this.fp = './bots/'+agent.name+'/screenshots/';
        // [ai-player] The camera is created only for a look and destroyed right after it. A camera kept
        // alive meshes the world around the bot continuously and pushed the service past its 1.5G limit.
        this.camera_view_distance = 4;
        this._startSnapshotRequests();
    }

    // [ai-player] Passive snapshot hook: an external watcher drops /home/dad/ai-player/run/snapshot-request.json
    // ({id, target:[x,y,z], width, height, viewDistance, box:[x1,y1,z1,x2,y2,z2]}). The camera renders from
    // Bob's eye toward the target WITHOUT turning his head, running a command or touching his action/history.
    // The image + a result JSON go to run/; the request file is removed. One render at a time.
    _startSnapshotRequests() {
        const dir = '/home/dad/ai-player/run';
        const req = path.join(dir, 'snapshot-request.json');
        if (this._snapTimer) return;
        this._snapTimer = setInterval(async () => {
            if (this._snapBusy || !fs.existsSync(req)) return;
            this._snapBusy = true;
            let r = {}, out = { ok: false };
            try {
                r = JSON.parse(fs.readFileSync(req, 'utf8')); fs.unlinkSync(req);
                out = await this._snapshot(r);
            } catch (e) { out = { ok: false, error: String(e?.message || e) }; try { fs.unlinkSync(req); } catch (_) {} }
            finally {
                try { fs.writeFileSync(path.join(dir, `snapshot-result-${r.id || 'x'}.json`), JSON.stringify(out)); } catch (_) {}
                this._snapBusy = false;
            }
        }, 2000);
    }

    async _snapshot(r) {
        const bot = this.agent.bot;
        if (!bot?.entity) return { ok: false, error: 'no bot entity' };
        const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
        const [tx, ty, tz] = r.target;
        const dx = tx - eye.x, dy = ty - eye.y, dz = tz - eye.z, ground = Math.hypot(dx, dz);
        const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, ground);
        // line of sight: first solid block on the ray toward the target; clear if it lies on/inside the house box
        let los = null;
        try {
            const dist = Math.hypot(dx, dy, dz);
            const dir = new Vec3(dx / dist, dy / dist, dz / dist);
            const hit = bot.world.raycast(eye, dir, dist + 2, b => b.boundingBox === 'block' || (b.name || '').includes('leaves'));
            const [x1, y1, z1, x2, y2, z2] = r.box || [tx - 4, ty - 2, tz - 4, tx + 4, ty + 2, tz + 4];
            const p = hit?.position;
            const inBox = p && p.x >= x1 - 1 && p.x <= x2 + 1 && p.y >= y1 - 1 && p.y <= y2 + 1 && p.z >= z1 - 1 && p.z <= z2 + 1;
            los = { clear: !p || !!inBox, hit: p ? `${hit.name}@${p.x},${p.y},${p.z}` : 'none' };
        } catch (e) { los = { clear: null, error: e.message }; }
        if (r.requireClear && los && los.clear === false) return { ok: false, skipped: 'line of sight blocked', los, pos: bot.entity.position };
        const t0 = Date.now();
        const pose = bot.entity.position.clone();
        const camera = new Camera(bot, this.fp, r.viewDistance || this.camera_view_distance, { width: r.width || 800, height: r.height || 512 });
        let filename;
        try { await camera.readyPromise; filename = await camera.capture({ yaw, pitch, pos: pose }); }
        finally { camera.destroy(); }
        const src = `${this.fp}/${filename}.jpg`, dst = `/home/dad/ai-player/run/snapshot-${r.id || 'x'}.jpg`;
        fs.copyFileSync(src, dst);
        let analysis = null;
        if (r.analyze && this.agent.prompter?.vision_model?.sendVisionRequest) {
            try {
                analysis = await Promise.race([
                    this.agent.prompter.vision_model.sendVisionRequest([], 'Describe this Minecraft screenshot in one or two sentences. Is a house or building clearly visible? Is the view blocked by leaves, terrain or a wall close to the camera? Answer starting with VISIBLE: yes/no, BLOCKED: yes/no.', fs.readFileSync(dst)),
                    new Promise(res => setTimeout(() => res('analysis timeout'), 60000))]);
            } catch (e) { analysis = 'analysis failed: ' + e.message; }
        }
        const p = pose;
        console.log(`[ai-player] snapshot ${r.id} rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) los=${los?.clear}`);
        return { ok: true, file: dst, pos: { x: p.x, y: p.y, z: p.z }, yaw, pitch, los, ms: Date.now() - t0, analysis, time: bot.time?.timeOfDay };
    }

    async _capture() {
        let camera = null;
        try {
            camera = new Camera(this.agent.bot, this.fp, this.camera_view_distance);
        } catch (err) {
            console.warn(`[ai-player] vision camera failed to start (${err?.message || err}); vision disabled for this session.`);
            this.allow_vision = false;
            throw new Error('camera unavailable');
        }
        try {
            const t0 = Date.now();
            await camera.readyPromise;
            const filename = await camera.capture();
            console.log(`[ai-player] vision capture ${filename} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
            return filename;
        } finally {
            camera.destroy();
        }
    }

    async lookAtPlayer(player_name, direction) {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        let result = "";
        const bot = this.agent.bot;
        const player = bot.players[player_name]?.entity;
        if (!player) {
            return `Could not find player ${player_name}`;
        }

        let filename;
        if (direction === 'with') {
            await bot.look(player.yaw, player.pitch);
            result = `Looking in the same direction as ${player_name}\n`;
            filename = await this._capture();
        } else {
            await bot.lookAt(new Vec3(player.position.x, player.position.y + player.height, player.position.z));
            result = `Looking at player ${player_name}\n`;
            filename = await this._capture();

        }

        return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
    }

    async lookAtPosition(x, y, z) {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        let result = "";
        const bot = this.agent.bot;
        await bot.lookAt(new Vec3(x, y + 2, z));
        result = `Looking at coordinate ${x}, ${y}, ${z}\n`;

        let filename = await this._capture();

        return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
    }

    getCenterBlockInfo() {
        const bot = this.agent.bot;
        const maxDistance = 128; // Maximum distance to check for blocks
        const targetBlock = bot.blockAtCursor(maxDistance);
        
        if (targetBlock) {
            return `Block at center view: ${targetBlock.name} at (${targetBlock.position.x}, ${targetBlock.position.y}, ${targetBlock.position.z})`;
        } else {
            return "No block in center view";
        }
    }

    async analyzeImage(filename) {
        try {
            const imageBuffer = fs.readFileSync(`${this.fp}/${filename}.jpg`);
            const messages = this.agent.history.getHistory();

            const blockInfo = this.getCenterBlockInfo();
            let result = await this.agent.prompter.promptVision(messages, imageBuffer);
            // [ai-player] The vision model sometimes appends a !command copied from the history; drop it.
            result = String(result ?? '').replace(/![a-zA-Z]+\([^)]*\)/g, '').trim() || 'No description.';
            return result + `\n${blockInfo}`;

        } catch (error) {
            console.warn('Error reading image:', error);
            return `Error reading image: ${error.message}`;
        }
    }
} 