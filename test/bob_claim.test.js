import test from 'node:test';
import assert from 'node:assert/strict';
import { CLAIM, claimBounds, isInClaim, verifiedHomeLocation } from '../src/agent/library/bob_claim.js';

test('128x128 claim is centered on the selected clearing', () => {
    assert.deepEqual(CLAIM.center, {x:-1144,z:752});
    assert.deepEqual(claimBounds(), {x1:-1208,x2:-1081,z1:688,z2:815});
    assert.equal((claimBounds().x2-claimBounds().x1+1)*(claimBounds().z2-claimBounds().z1+1),16384);
});
test('claim membership includes boundaries, excludes outside and invalid positions', () => {
    assert.equal(isInClaim({x:-1208,z:688}),true);
    assert.equal(isInClaim({x:-1081,z:815}),true);
    assert.equal(isInClaim({x:-1209,z:688}),false);
    assert.equal(isInClaim({x:-1080,z:815}),false);
    assert.equal(isInClaim(null),false);
});
test('claim center is never treated as an automatically discovered home', () => {
    assert.equal(verifiedHomeLocation(null),null);
    assert.equal(verifiedHomeLocation({position:{x:-1144,y:65,z:752}}),null);
    assert.deepEqual(verifiedHomeLocation({verified:true,position:{x:-1140,y:66,z:750}}),{x:-1140,y:66,z:750});
});
