import { Viewer } from 'prismarine-viewer/viewer/lib/viewer.js';
import { WorldView } from 'prismarine-viewer/viewer/lib/worldView.js';
import { getBufferFromStream } from 'prismarine-viewer/viewer/lib/simpleUtils.js';

import THREE from 'three';
import { createCanvas } from 'node-canvas-webgl/lib/index.js';
import fs from 'fs/promises';
import { Vec3 } from 'vec3';
import { EventEmitter } from 'events';

import worker_threads from 'worker_threads';
global.Worker = worker_threads.Worker;


export class Camera extends EventEmitter {
    constructor (bot, fp, viewDistance = 12, size = null) {
        super();
        this.bot = bot;
        this.fp = fp;
        this.viewDistance = viewDistance;
        this.width = size?.width || 800;
        this.height = size?.height || 512;
        this.canvas = createCanvas(this.width, this.height);
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas });
        this.viewer = new Viewer(this.renderer);
        // [ai-player] One mesher worker instead of four: each worker thread holds its own copy of the
        // block data (~100 MB), and a single short capture does not need the parallelism.
        for (const w of this.viewer.world.workers.slice(1)) w.terminate();
        this.viewer.world.workers.length = 1;
        this.readyPromise = this._init().then(() => {
            this.emit('ready');
        });
    }
  
    async _init () {
        const botPos = this.bot.entity.position;
        const center = new Vec3(botPos.x, botPos.y+this.bot.entity.height, botPos.z);
        this.viewer.setVersion(this.bot.version);
        // Load world
        const worldView = new WorldView(this.bot.world, this.viewDistance, center);
        this.viewer.listen(worldView);
        worldView.listenToBot(this.bot);
        await worldView.init(center);
        this.worldView = worldView;
    }
  
    async capture(view = null) {
        const at = view?.pos || this.bot.entity.position; // [ai-player] optional frozen pose (where the shot was requested)
        const center = new Vec3(at.x, at.y+this.bot.entity.height, at.z);
        this.viewer.camera.position.set(center.x, center.y, center.z);
        await this.worldView.updatePosition(center);
        // [ai-player] wait (bounded) for the mesher workers so the shot is not just sky
        await Promise.race([
            this.viewer.world.waitForChunksToRender(),
            new Promise(r => setTimeout(r, 15000))
        ]);
        // [ai-player] optional view override (render toward a target without turning the bot's head)
        this.viewer.setFirstPersonCamera(at, view?.yaw ?? this.bot.entity.yaw, view?.pitch ?? this.bot.entity.pitch);
        this.viewer.update();
        this.renderer.render(this.viewer.scene, this.viewer.camera);

        const imageStream = this.canvas.createJPEGStream({
            bufsize: 4096,
            quality: 100,
            progressive: false
        });
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `screenshot_${timestamp}`;

        const buf = await getBufferFromStream(imageStream);
        await this._ensureScreenshotDirectory();
        await fs.writeFile(`${this.fp}/${filename}.jpg`, buf);
        console.log('saved', filename);
        return filename;
    }

    // [ai-player] Free everything (bot listeners, mesher worker threads, GL context) after a capture,
    // so an idle bot carries no renderer memory or CPU.
    destroy() {
        try { if (this.worldView) this.worldView.removeListenersFromBot(this.bot); } catch (e) {}
        try { for (const w of this.viewer.world.workers || []) w.terminate(); } catch (e) {}
        try { this.renderer.dispose(); } catch (e) {}
        try {
            const gl = this.renderer.getContext();
            const ext = gl && gl.getExtension('STACKGL_destroy_context');
            if (ext) ext.destroy();
        } catch (e) {}
        this.worldView = null;
    }

    async _ensureScreenshotDirectory() {
        let stats;
        try {
            stats = await fs.stat(this.fp);
        } catch (e) {
            if (!stats?.isDirectory()) {
                await fs.mkdir(this.fp);
            }
        }
    }
}
  
