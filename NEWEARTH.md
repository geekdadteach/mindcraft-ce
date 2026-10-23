# NewEarth live snapshot (LinuxGrok .60)

This branch is the Mindcraft CE tree that runs MineBobNE on the NewEarth family server, captured unchanged from LinuxGrok (192.168.1.60) on 2026-10-23.

- Upstream base: mindcraft-ce stable `42da10d`
- Node: `v22.22.1`
- npm: `9.2.0`
- Dependencies: `package-lock.json` is the live lockfile, force-added past `.gitignore`.
- Patches: `patches/` is applied by patch-package through the `postinstall` script in `package.json`, so `npm ci` (or `npm install`) re-applies them. The live tree has 8 patches: minecraft-data 3.97.0, mineflayer 4.33.0, mineflayer-collectblock 1.6.0, mineflayer-pathfinder 2.4.5, mineflayer-pvp 1.3.2, prismarine-item 1.18.0, prismarine-viewer 1.33.0, protodef 1.19.0.
- Not included: `keys.json`, `bots/` (memory, lessons, skills, histories), logs, `node_modules/` and all secrets.
