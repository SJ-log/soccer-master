// 터치라인 — 화면과 분리한 계산 로직 (node로 검사 가능)
(function (root) {
  'use strict';
  const NONE = 32767;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // 브라우저 시각이 소수점에서 살짝 모자라게 나오는 경우를 허용한다.
  // t0: 영상 파일에서 첫 화면이 나오는 시각(초)
  const frameAt = (time, fps, frames, t0) => clamp(Math.floor((time - (t0 || 0)) * fps + 1e-4), 0, frames - 1);
  const fmtTime = (sec) => { sec = Math.max(0, Math.floor(sec)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };

  function boxAt(p, f) {
    const i = f - p.f0; if (i < 0 || i >= p.n) return null;
    const w = p.box[i * 4 + 2]; if (!w) return null;
    return [p.box[i * 4], p.box[i * 4 + 1], w, p.box[i * 4 + 3]];
  }
  function posAt(p, f) {   // 경기장 좌표(m), 원점은 경기장 중앙
    if (!p.pos) return null;          // 경기장을 아직 맞추지 않은 영상
    const i = f - p.f0; if (i < 0 || i >= p.n) return null;
    const x = p.pos[i * 2]; if (x === NONE) return null;
    return [x / 100, p.pos[i * 2 + 1] / 100];
  }
  function speedAt(p, f, fps) {   // 앞뒤 약 0.5초 사이 이동으로 계산한 속도(m/s)
    const h = Math.round(fps / 2); const a = posAt(p, Math.max(p.f0, f - h)), b = posAt(p, Math.min(p.f0 + p.n - 1, f + h));
    if (!a || !b) return null;
    const dt = (Math.min(p.f0 + p.n - 1, f + h) - Math.max(p.f0, f - h)) / fps;
    return dt > 0 ? Math.hypot(b[0] - a[0], b[1] - a[1]) / dt : null;
  }
  function pickBox(players, f, vx, vy, reach) {   // 영상 좌표에서 가장 가까운 박스
    let best = null, bd = Infinity;
    for (const p of players) {
      const b = boxAt(p, f); if (!b) continue;
      const dx = Math.max(b[0] - vx, 0, vx - (b[0] + b[2])), dy = Math.max(b[1] - vy, 0, vy - (b[1] + b[3])), d = Math.hypot(dx, dy);
      if (d < bd) { bd = d; best = p.id; }
    }
    return bd <= reach ? best : null;
  }
  function pickDot(players, f, x, y, reach) {     // 경기장 좌표에서 가장 가까운 선수
    let best = null, bd = Infinity;
    for (const p of players) { const q = posAt(p, f); if (!q) continue; const d = Math.hypot(q[0] - x, q[1] - y); if (d < bd) { bd = d; best = p.id; } }
    return bd <= reach ? best : null;
  }
  // 비교 대상: 신원이 있으면 같은 팀 필드 선수, 없으면 관측 시간이 비슷한(최장의 80% 이상) 기록
  function peers(players, sel, hasIdentity) {
    if (hasIdentity) return players.filter(p => p.team === sel.team && p.role === 0);
    const mx = Math.max(...players.map(p => p.observed_sec)); return players.filter(p => p.observed_sec >= 0.8 * mx);
  }
  const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  function compare(players, sel, hasIdentity, key) {
    const g = peers(players, sel, hasIdentity); const avg = mean(g.map(p => p[key])); const max = Math.max(1e-9, ...g.map(p => p[key]), sel[key]);
    return { avg, max, n: g.length, diffPct: avg > 0 ? (sel[key] - avg) / avg * 100 : 0 };
  }
  function halves(p) {   // 관측 구간을 앞뒤 절반으로 나눈 이동 거리(m). 1초 평균 속도의 합.
    const v = p.speed_1hz.map(x => x || 0), h = Math.floor(v.length / 2);
    return [v.slice(0, h).reduce((a, b) => a + b, 0), v.slice(h).reduce((a, b) => a + b, 0)];
  }
  // 수치에 근거한 한 줄 조언. 가장 두드러진 것 하나만 말한다. frame: 근거 장면으로 이동할 프레임(없으면 null)
  function advice(players, sel, hasIdentity, groupName) {
    const [h1, h2] = halves(sel); const dist = compare(players, sel, hasIdentity, 'distance_m'), hsr = compare(players, sel, hasIdentity, 'hsr_count');
    const run = sel.fast_runs.length ? sel.fast_runs.reduce((a, b) => (b.avg > a.avg ? b : a)) : null;
    const zmax = Math.max(...sel.zone_share.flat());
    if (sel.observed_sec < 30) return { text: '기록이 ' + Math.round(sel.observed_sec) + '초로 짧아서 조언을 만들지 않았어요.', frame: null };
    if (h1 > 0 && h2 < 0.85 * h1) return { text: '뒤 절반의 이동 거리가 앞 절반보다 ' + Math.round((1 - h2 / h1) * 100) + '% 적었어요. 후반 활동량을 살펴보세요.', frame: sel.speed_f0 + Math.floor(sel.speed_1hz.length / 2) * 25 };
    if (hsr.n > 1 && sel.hsr_count >= hsr.avg + 1.5) return { text: '고속 달리기가 ' + sel.hsr_count + '회로 ' + groupName + ' 평균(' + hsr.avg.toFixed(1) + '회)보다 많았어요. 가장 빨랐던 장면을 다시 확인해 보세요.', frame: run ? run.start : null };
    if (dist.n > 1 && dist.diffPct <= -10) return { text: '이동 거리가 ' + groupName + ' 평균보다 ' + Math.round(-dist.diffPct) + '% 적었어요. 공이 없을 때의 움직임을 확인해 보세요.', frame: null };
    if (dist.n > 1 && dist.diffPct >= 10) return { text: '이동 거리가 ' + groupName + ' 평균보다 ' + Math.round(dist.diffPct) + '% 많았어요. 활동량이 강점이에요.', frame: run ? run.start : null };
    if (zmax >= 0.35) return { text: '머문 시간의 ' + Math.round(zmax * 100) + '%가 한 구역에 몰려 있었어요. 활동 구역을 확인해 보세요.', frame: null };
    if (sel.hsr_count === 0) return { text: '고속 달리기(초속 ' + '5.5m 이상)가 한 번도 없었어요. 속도를 낼 장면이 있었는지 살펴보세요.', frame: null };
    return { text: '이동 거리와 고속 달리기 모두 ' + groupName + ' 평균과 비슷했어요.', frame: run ? run.start : null };
  }
  const api = { NONE, clamp, frameAt, fmtTime, boxAt, posAt, speedAt, pickBox, pickDot, peers, compare, halves, advice, mean };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TLCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
