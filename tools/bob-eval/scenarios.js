// [bob-eval] Five deterministic offline scenarios. `script` is the mocked LLM: one reply per model call,
// in order. Success is decided ONLY by `checks` against the fake world state (never by task.finished).
// `expect` is what the current Bob loop should produce; the report flags any mismatch.

export const SCENARIOS = [
    {
        id: 'logs',
        title: 'Collect 5 oak logs',
        goal: 'Collect at least 5 oak logs.',
        setup(world) { world.addTree(5, 0, 4); world.addTree(-6, 3, 3); },
        start: { position: { x: 0, y: 64, z: 0 }, inventory: {} },
        script: [
            '!collectBlocks("oak_log", 5)',
            'I have the oak logs now.',
        ],
        checks: [{ kind: 'inventory', item: 'oak_log', min: 5 }],
        expect: { pass: true },
    },
    {
        id: 'navigation',
        title: 'Walk to a reachable target (recovers from one malformed command)',
        goal: 'Go to x=20 y=64 z=-15.',
        setup() {},
        start: { position: { x: 0, y: 64, z: 0 }, inventory: {} },
        script: [
            '!goToCoordinates(20, 64)',              // parser incident: 2 of 4 args
            'Fixing that. !goToCoordinates(20, 64, -15, 1)',
            'I am there.',
        ],
        checks: [{ kind: 'distance', target: { x: 20, y: 64, z: -15 }, max: 2 }],
        expect: { pass: true },
    },
    {
        id: 'crafting',
        title: 'Craft a crafting table from logs (recovers from a hallucinated command)',
        goal: 'Craft a crafting table.',
        setup() {},
        start: { position: { x: 0, y: 64, z: 0 }, inventory: { oak_log: 3 } },
        script: [
            '!craft("crafting_table")',              // parser incident: command does not exist
            '!craftRecipe("oak_planks", 1)',
            '!craftRecipe("crafting_table", 1)',
            'Crafting table done.',
        ],
        checks: [{ kind: 'inventory', item: 'crafting_table', min: 1 }],
        expect: { pass: true },
    },
    {
        id: 'shelter',
        title: 'Build a starter shelter around/over the bot',
        goal: 'Build a small shelter around yourself before night.',
        setup() {},
        start: { position: { x: 0, y: 64, z: 0 }, inventory: { oak_planks: 12 } },
        script: [
            '!continueHomestead',
            '!continueHomestead',
            'Shelter built.',
        ],
        checks: [{ kind: 'shelter' }],
        expect: { pass: true },
    },
    {
        id: 'unreachable',
        title: 'Unreachable target (sealed box): must fail objectively and stop retrying',
        goal: 'Go to x=40 y=70 z=40.',
        setup(world) { world.addSealedBox({ x: 39, y: 69, z: 39 }, { x: 41, y: 71, z: 41 }); },
        start: { position: { x: 0, y: 64, z: 0 }, inventory: {} },
        script: [
            '!goToCoordinates(40, 70, 40, 1)',
            '!goToCoordinates(40, 70, 40, 1)',
            '!goToCoordinates(40, 70, 40, 1)',       // 3rd similar within 2 min: RepeatGuard blocks it
            'I cannot reach that spot.',
        ],
        checks: [{ kind: 'distance', target: { x: 40, y: 70, z: 40 }, max: 2 }],
        expect: { pass: false, failure_class: 'action', min_guard_blocks: 1 },
    },
];

export function getScenario(id) {
    return SCENARIOS.find(s => s.id === id) || null;
}
