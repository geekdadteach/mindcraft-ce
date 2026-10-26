import test from 'node:test';
import assert from 'node:assert/strict';
import { join, isAbsolute } from 'node:path';
import {
    bobRuntimeRoot,
    bobRuntimePath
} from '../src/utils/bob_runtime_paths.js';

test('runtime root is absolute', () => {
    assert.ok(isAbsolute(bobRuntimeRoot()));
});

test('runtime paths use the selected root', () => {
    assert.equal(
        bobRuntimePath('run', 'bob-mode.active'),
        join(bobRuntimeRoot(), 'run', 'bob-mode.active')
    );

    assert.equal(
        bobRuntimePath('logs', 'node-reports'),
        join(bobRuntimeRoot(), 'logs', 'node-reports')
    );
});

test('invalid paths cannot escape the runtime', () => {
    for (const segment of [
        '..',
        '../outside',
        'nested/file',
        '/tmp',
        'nested\\file'
    ]) {
        assert.throws(
            () => bobRuntimePath(segment),
            /Invalid Bob runtime path segment/
        );
    }
});
