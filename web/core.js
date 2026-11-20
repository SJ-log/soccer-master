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
  // ---- 기록 잇기 ----
  // 한 선수의 기록 = 조각의 목록 [{track, from, to}] (프레임, 양끝 포함, 시간 순, 서로 겹치지 않음)
  const last = (t) => t.f0 + t.n - 1;
  const foot = (b) => [b[0] + b[2] / 2, b[1] + b[3]];
  const stitch = {
    GAP: 125,      // 끊긴 뒤 이 프레임 수 안에 나타나는 기록만 후보로 본다 (25fps에서 5초)
    REACH: [2.0, 0.4],   // 후보 거리 한계 = 박스 높이 × (2.0 + 0.4 × 지난 프레임 수)
    chainBox(parts, byId, f) {       // 그 프레임에서 내 박스와 그 박스가 속한 기록
      for (const p of parts) if (f >= p.from && f <= p.to) { const b = boxAt(byId[p.track], f); return b ? { box: b, track: p.track } : null; }
      return null;
    },
    range(parts) { return parts.length ? [parts[0].from, parts[parts.length - 1].to] : null; },
    // f부터는 이 기록이 나다: f 이후의 조각은 버리고 이 기록을 끝까지 붙인다
    continueFrom(parts, byId, f, track) {
      const t = byId[track], out = [];
      for (const p of parts) { if (p.from >= f) continue; out.push({ track: p.track, from: p.from, to: Math.min(p.to, f - 1) }); }
      const from = Math.max(f, t.f0); if (from <= last(t)) out.push({ track, from, to: last(t) });
      return out;
    },
    // 내 기록이 시작되기 전 구간을 이 기록으로 채운다
    prepend(parts, byId, track) {
      const t = byId[track], to = Math.min(parts[0].from - 1, last(t));
      return to >= t.f0 ? [{ track, from: t.f0, to }].concat(parts) : parts;
    },
    // f부터는 내가 아니다
    cut(parts, f) {
      const out = [];
      for (const p of parts) { if (p.from >= f) continue; out.push({ track: p.track, from: p.from, to: Math.min(p.to, f - 1) }); }
      return out;
    },
    // 내 기록이 끝난 뒤(dir=1) 또는 시작되기 전(dir=-1)에 이어질 만한 기록을 가까운 순서로
    candidates(tracks, byId, parts, dir, fps, limit) {
      if (!parts.length) return [];
      const edge = dir > 0 ? parts[parts.length - 1] : parts[0], e = dir > 0 ? edge.to : edge.from; let ref = null;
      for (let k = 0; k < 25 && !ref; k++) ref = boxAt(byId[edge.track], e - dir * k);
      if (!ref) return [];
      // 끊기기 직전 0.4초의 움직임이 1초까지 이어진다고 보고 예상 위치를 잡는다
      const rf = foot(ref), prev = boxAt(byId[edge.track], e - dir * 10), vel = prev ? [(rf[0] - foot(prev)[0]) / 10, (rf[1] - foot(prev)[1]) / 10] : [0, 0], out = [];
      for (const t of tracks) {
        if (t.id === edge.track) continue;
        for (let dt = 1; dt <= stitch.GAP; dt++) {
          const g = e + dir * dt; if (g < t.f0 || g > last(t)) { if ((dir > 0 && g > last(t)) || (dir < 0 && g < t.f0)) break; continue; }
          const b = boxAt(t, g); if (!b) continue;
          const k = Math.min(dt, fps), d = Math.hypot(foot(b)[0] - rf[0] - vel[0] * k, foot(b)[1] - rf[1] - vel[1] * k) / ref[3];
          // 내 기록이 끊기기 전부터 따로 있던 기록은 다른 선수일 가능성이 높아 뒤로 보낸다
          const existed = dir > 0 ? t.f0 <= e : last(t) >= e;
          if (d <= stitch.REACH[0] + stitch.REACH[1] * dt) out.push({ track: t.id, frame: g, dt, existed, score: d + dt / fps + (existed ? 1.5 : 0) });
          break;      // 그 기록이 처음(또는 마지막으로) 보이는 프레임만 본다
        }
      }
      return out.sort((a, b) => a.score - b.score).slice(0, limit || 5);
    },
    // 내 박스가 다른 기록의 박스와 겹친 구간: 겹친 뒤 다른 선수로 넘어갔는지 확인할 곳
    crossings(tracks, byId, parts, minIou, mergeGap) {
      const hits = [];
      for (const p of parts) {
        const me = byId[p.track];
        for (let f = p.from; f <= p.to; f++) {
          const a = boxAt(me, f); if (!a) continue;
          for (const t of tracks) {
            if (t.id === p.track) continue; const b = boxAt(t, f); if (!b) continue;
            const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]), h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
            if (w > 0 && h > 0 && w * h / (a[2] * a[3] + b[2] * b[3] - w * h) >= (minIou || 0.2)) { hits.push(f); break; }
          }
        }
      }
      const out = [];
      for (const f of hits) { const c = out[out.length - 1]; if (c && f - c.end <= (mergeGap || 25)) c.end = f; else out.push({ start: f, end: f }); }
      return out;
    },
  };
  const api = { NONE, clamp, frameAt, fmtTime, boxAt, posAt, speedAt, pickBox, pickDot, peers, compare, halves, advice, mean, stitch };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TLCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
