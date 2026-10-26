// [long-memory-20261026] lane-aware advice receipts + $LONG_MEMORY guarantee for the conversation prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BobBrain, withConversationAdvice } from '../src/agent/library/bob_brain.js';
import { ensureLongMemoryPlaceholder } from '../src/models/prompter.js';

const quiet = { lines: [], log(m) { this.lines.push(String(m)); }, warn(m) { this.lines.push(String(m)); } };
const events = (f) => existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

test('non-conversation lanes do not emit a wrong_prompt rejection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-lane-'));
    const file = join(dir, 'v2.jsonl');
    try {
        const brain = new BobBrain({ enabled: false, reason: 'test' }, { log: quiet, now: () => 1_000_000, env: { BOB_BRAIN_V2_EVENT_LOG: file } });
        brain._storeAdvice({ id: 'job-9', kind: 'plan', result: { summary: 'Build a shelter before night' } });
        for (const lane of ['memory', 'coding', 'responder', 'vision'])
            brain.observeAssembledPrompt('Old Memory.\n$TO_SUMMARIZE', { conversationPrompt: false, armAction: false, lane });
        assert.equal(events(file).filter((e) => e.type === 'advice_rejected').length, 0);

        const prompt = withConversationAdvice('You are Bob.\n$LONG_MEMORY\nstats', brain.adviceBlock());
        brain.observeAssembledPrompt(prompt, { conversationPrompt: true, armAction: false, lane: 'conversation' });
        assert.equal(events(file).filter((e) => e.type === 'advice_injected').length, 1);

        // legacy caller (no lane) keeps the old behaviour: one wrong_prompt per trace
        brain.observeAssembledPrompt('Write code.\n$CODE_DOCS', { conversationPrompt: false, armAction: false });
        assert.equal(events(file).filter((e) => /no \$LONG_MEMORY/.test(e.summary)).length, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ensureLongMemoryPlaceholder inserts once, before $STATS', () => {
    assert.equal(ensureLongMemoryPlaceholder('a $LONG_MEMORY b'), 'a $LONG_MEMORY b');
    assert.equal(ensureLongMemoryPlaceholder("mem:'$MEMORY'\n$STATS\n$INVENTORY"), "mem:'$MEMORY'\n$LONG_MEMORY\n$STATS\n$INVENTORY");
    assert.equal(ensureLongMemoryPlaceholder('x\nConversation Begin:'), 'x\n$LONG_MEMORY\nConversation Begin:');
    assert.equal(ensureLongMemoryPlaceholder('plain'), 'plain\n$LONG_MEMORY');
});
