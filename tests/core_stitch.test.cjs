// 기록 잇기 계산 검사.  실행: node tests/core_stitch.test.cjs
const assert = require('assert');
const C = require('../web/core.js'), S = C.stitch;
// 기록 만들기: f0부터 n프레임, x는 프레임마다 dx씩 이동
const mk = (id, f0, n, x0, y0, dx) => { const box = []; for (let i = 0; i < n; i++) box.push(x0 + i * dx, y0, 20, 60); return { id, f0, n, box }; };
const tracks = [
  mk(1, 0, 100, 100, 400, 2),       // 나: 0~99
  mk(2, 110, 100, 320, 400, 2),     // 10프레임 뒤 같은 자리에서 이어짐: 나의 다음 조각
  mk(3, 105, 100, 1500, 700, 0),    // 멀리 있는 다른 선수
  mk(4, 0, 300, 180, 400, 0),       // 프레임 40 근처에서 나와 겹치는 선수
  mk(5, 0, 50, 0, 400, 2),          // 내 기록(6번)이 시작되기 전 구간
  mk(6, 55, 100, 110, 400, 2),
];
const byId = Object.fromEntries(tracks.map(t => [t.id, t]));
let parts = [{ track: 1, from: 0, to: 99 }];
// 후보: 이어지는 2번이 첫째, 멀리 있는 3번은 빠진다
let c = S.candidates(tracks, byId, parts, 1, 25);
assert.strictEqual(c[0].track, 2); assert.strictEqual(c[0].frame, 110); assert.ok(!c.some(x => x.track === 3));
// 끊기기 전부터 옆에 있던 7번은 더 가깝게 보여도 새로 나타난 2번보다 뒤다
const near = mk(7, 0, 300, 300, 400, 0), c7 = S.candidates(tracks.concat([near]), Object.assign({ 7: near }, byId), parts, 1, 25);
assert.strictEqual(c7[0].track, 2); assert.ok(!c7[0].existed); assert.ok(c7.find(x => x.track === 7).existed); assert.ok(c7.findIndex(x => x.track === 7) > 0);
// 잇기
parts = S.continueFrom(parts, byId, c[0].frame, 2);
assert.deepStrictEqual(parts, [{ track: 1, from: 0, to: 99 }, { track: 2, from: 110, to: 209 }]);
assert.deepStrictEqual(S.range(parts), [0, 209]);
assert.strictEqual(S.chainBox(parts, byId, 50).track, 1); assert.strictEqual(S.chainBox(parts, byId, 105), null); assert.strictEqual(S.chainBox(parts, byId, 150).track, 2);
// 자르기: 150부터 내가 아니다
assert.deepStrictEqual(S.cut(parts, 150), [{ track: 1, from: 0, to: 99 }, { track: 2, from: 110, to: 149 }]);
assert.deepStrictEqual(S.cut(parts, 105), [{ track: 1, from: 0, to: 99 }]);
// 중간부터 다른 기록으로 바꾸기: 60부터 4번
assert.deepStrictEqual(S.continueFrom(parts, byId, 60, 4), [{ track: 1, from: 0, to: 59 }, { track: 4, from: 60, to: 299 }]);
// 겹친 곳: 1번이 x=180 근처(프레임 40 앞뒤)를 지날 때 4번과 겹친다
const cr = S.crossings(tracks, byId, [{ track: 1, from: 0, to: 99 }], 0.2, 25);
assert.strictEqual(cr.length, 1); assert.ok(cr[0].start <= 40 && cr[0].end >= 40 && cr[0].start > 25 && cr[0].end < 55);
// 앞쪽 후보와 앞에 붙이기
const p6 = [{ track: 6, from: 55, to: 154 }]; c = S.candidates(tracks, byId, p6, -1, 25);
assert.strictEqual(c[0].track, 5); assert.strictEqual(c[0].frame, 49);
assert.deepStrictEqual(S.prepend(p6, byId, 5), [{ track: 5, from: 0, to: 49 }, { track: 6, from: 55, to: 154 }]);
console.log('core_stitch: 통과');
