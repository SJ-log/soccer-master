// 터치라인 — 복기 화면과 선수 리포트. 서버가 만든 결과(/api/videos/<id>/data)를 읽는다.
window.TLStart = function () {
  'use strict';
  const C = window.TLCore, SOURCES = window.TL_SOURCES || {};
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const svg = (tag, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
  const TEAM = {
    '0': { name: '왼쪽 팀', fill: '#1F4E9E', stroke: '#FFFFFF', box: '#9DBBFF' },
    '1': { name: '오른쪽 팀', fill: '#FFFFFF', stroke: '#17211C', box: '#FFFFFF' },
    '-1': { name: '기록', fill: '#C9CEC9', stroke: '#17211C', box: '#DCE8E0' },
  };
  const HI = '#FF9A4D', TRAIL_SEC = 30, CROP = [640, 360];
  const video = $('video'), overlay = $('overlay'), follow = $('follow'), minimap = $('minimap');
  let src, players, byId, sel, fps = 25, frames = 1, t0 = 0, frame = 0, lastCenter = null, currentAdvice = null;

  if (!C || !Object.keys(SOURCES).length) { $('loadError').hidden = false; $('loadError').textContent = '처리 결과를 읽지 못했어요.'; return; }

  // ---------- 데이터 선택 ----------
  for (const key of ['gt', 'track']) if (SOURCES[key]) { const o = el('option', null, SOURCES[key].label); o.value = key; $('sourceSelect').appendChild(o); }
  function setSource(key) {
    src = SOURCES[key]; players = src.players; byId = new Map(players.map(p => [p.id, p])); fps = src.clip.fps; frames = src.clip.frames; t0 = src.clip.t0 || 0;
    if (!video.getAttribute('src')) video.src = src.clip.video;
    $('sourceNote').textContent = src.clip.label + ' · ' + src.note;
    document.body.classList.toggle('no-pos', !src.has_positions);
    buildChips(); buildLegend();
    const def = players[0];
    select(def.id);
  }
  function label(p) { return p.name + (p.role === 1 ? ' (골키퍼)' : ''); }
  function buildChips() {
    const box = $('chipGroups'); box.textContent = '';
    const groups = src.has_identity ? [0, 1].map(t => [TEAM[t].name, players.filter(p => p.team === t).sort((a, b) => a.role - b.role || a.jersey - b.jersey)]) : [['기록', players]];
    for (const [name, list] of groups) {
      const row = el('div', 'chip-row'); row.appendChild(el('span', null, name));
      for (const p of list) {
        const b = el('button', 'chip', src.has_identity ? label(p) : p.name + ' · ' + C.fmtTime(p.observed_sec)); b.type = 'button'; b.dataset.id = p.id;
        b.addEventListener('click', () => select(p.id)); row.appendChild(b);
      }
      box.appendChild(row);
    }
  }
  function buildLegend() {
    const lg = $('mapLegend'); lg.textContent = '';
    const add = (fill, text) => { const s = el('span'); const i = el('i', 'lg dot'); i.style.background = fill; s.appendChild(i); s.appendChild(document.createTextNode(text)); lg.appendChild(s); };
    if (src.has_identity) { add(TEAM[0].fill, TEAM[0].name); add(TEAM[1].fill, TEAM[1].name); } else add(TEAM[-1].fill, '추적 기록');
    add(HI, '선택한 선수와 경로');
  }
  function select(id) {
    if (!byId.has(id)) return; sel = byId.get(id); lastCenter = null;
    document.querySelectorAll('.chip').forEach(c => { const on = Number(c.dataset.id) === id; c.classList.toggle('sel', on); c.setAttribute('aria-pressed', on); });
    $('followTitle').textContent = '확대 화면 · ' + label(sel) + ' 따라가기';
    renderTimeline(); renderSummary(); renderReport(); draw();
  }

  // ---------- 영상과 프레임 ----------
  const seekFrame = (f) => { video.currentTime = Math.min(video.duration || 1e9, t0 + (C.clamp(f, 0, frames - 1) + 0.5) / fps); };
  function tick(now, meta) { frame = C.frameAt(meta ? meta.mediaTime : video.currentTime, fps, frames, t0); draw(); schedule(); }
  function schedule() { if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick); else requestAnimationFrame(() => tick()); }
  function refresh() { frame = C.frameAt(video.currentTime, fps, frames, t0); draw(); }
  video.addEventListener('seeked', refresh); video.addEventListener('timeupdate', refresh); video.addEventListener('loadeddata', refresh);
  video.addEventListener('play', () => { $('playBtn').textContent = '정지'; });
  video.addEventListener('pause', () => { $('playBtn').textContent = '재생'; });
  video.addEventListener('error', () => { $('loadError').hidden = false; $('loadError').textContent = '영상 파일을 열지 못했어요. 처리가 끝났는지 확인해 주세요.'; });
  $('playBtn').addEventListener('click', () => { if (video.paused) video.play(); else video.pause(); });
  $('speed').addEventListener('change', (e) => { video.playbackRate = Number(e.target.value); });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input,select,textarea,button')) return;
    if (e.code === 'Space') { e.preventDefault(); $('playBtn').click(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); seekFrame(frame - fps); }
    if (e.key === 'ArrowRight') { e.preventDefault(); seekFrame(frame + fps); }
  });

  // ---------- 그리기 ----------
  function sizeOverlay() {
    const r = $('videoWrap').getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
  }
  function cropRect() {
    const b = C.boxAt(sel, frame); if (b) lastCenter = [b[0] + b[2] / 2, b[1] + b[3] / 2];
    if (!lastCenter) return null;
    const W = src.clip.width, H = src.clip.height;
    return [C.clamp(lastCenter[0] - CROP[0] / 2, 0, W - CROP[0]), C.clamp(lastCenter[1] - CROP[1] / 2, 0, H - CROP[1]), CROP[0], CROP[1]];
  }
  function drawOverlay(crop) {
    sizeOverlay(); const ctx = overlay.getContext('2d'), k = overlay.width / src.clip.width, dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    for (const p of players) {
      if (p === sel) continue; const b = C.boxAt(p, frame); if (!b) continue;
      ctx.strokeStyle = TEAM[p.team].box; ctx.lineWidth = dpr; ctx.strokeRect(b[0] * k, b[1] * k, b[2] * k, b[3] * k);
    }
    if (crop) { ctx.strokeStyle = HI; ctx.lineWidth = dpr; ctx.setLineDash([6 * dpr, 4 * dpr]); ctx.strokeRect(crop[0] * k, crop[1] * k, crop[2] * k, crop[3] * k); ctx.setLineDash([]); }
    const b = C.boxAt(sel, frame);
    if (b) {
      ctx.strokeStyle = HI; ctx.lineWidth = 3 * dpr; ctx.strokeRect(b[0] * k - 2 * dpr, b[1] * k - 2 * dpr, b[2] * k + 4 * dpr, b[3] * k + 4 * dpr);
      ctx.font = '700 ' + 13 * dpr + 'px sans-serif'; const t = sel.name, tw = ctx.measureText(t).width + 12 * dpr, tx = C.clamp((b[0] + b[2] / 2) * k - tw / 2, 0, overlay.width - tw), ty = Math.max(0, b[1] * k - 24 * dpr);
      ctx.fillStyle = HI; ctx.fillRect(tx, ty, tw, 19 * dpr); ctx.fillStyle = '#2A1300'; ctx.textBaseline = 'middle'; ctx.fillText(t, tx + 6 * dpr, ty + 10 * dpr);
    }
  }
  function drawFollow(crop) {
    const ctx = follow.getContext('2d'), k = follow.width / CROP[0];
    ctx.fillStyle = '#264a37'; ctx.fillRect(0, 0, follow.width, follow.height);
    const b = C.boxAt(sel, frame); $('followMsg').hidden = !!b;
    if (!crop) return;
    try { if (video.readyState >= 2) ctx.drawImage(video, crop[0], crop[1], crop[2], crop[3], 0, 0, follow.width, follow.height); } catch (e) { /* 영상이 아직 준비되지 않음 */ }
    for (const p of players) {
      if (p === sel) continue; const q = C.boxAt(p, frame); if (!q) continue;
      if (q[0] + q[2] < crop[0] || q[0] > crop[0] + crop[2] || q[1] + q[3] < crop[1] || q[1] > crop[1] + crop[3]) continue;
      ctx.strokeStyle = TEAM[p.team].box; ctx.lineWidth = 1.5; ctx.strokeRect((q[0] - crop[0]) * k, (q[1] - crop[1]) * k, q[2] * k, q[3] * k);
    }
    if (b) {
      const x = (b[0] - crop[0]) * k, y = (b[1] - crop[1]) * k; ctx.strokeStyle = HI; ctx.lineWidth = 4; ctx.strokeRect(x - 3, y - 3, b[2] * k + 6, b[3] * k + 6);
      const v = C.speedAt(sel, frame, fps), t = sel.name + (v == null ? '' : ' · ' + v.toFixed(1) + ' m/s');
      ctx.font = '700 22px sans-serif'; const tw = ctx.measureText(t).width + 16, tx = C.clamp(x + b[2] * k / 2 - tw / 2, 0, follow.width - tw), ty = Math.max(0, y - 40);
      ctx.fillStyle = HI; ctx.fillRect(tx, ty, tw, 30); ctx.fillStyle = '#2A1300'; ctx.textBaseline = 'middle'; ctx.fillText(t, tx + 8, ty + 16);
    }
  }
  // 미니맵: 경기장 좌표(m) -> 캔버스 좌표. 영상과 같은 방향(카메라 쪽이 아래)이다.
  const MAP = (() => { const L = 105, Wd = 68, k = Math.min((minimap.width - 30) / L, (minimap.height - 30) / Wd); return { k, ox: (minimap.width - L * k) / 2, oy: (minimap.height - Wd * k) / 2, L, Wd }; })();
  const mx = (x) => MAP.ox + (x + MAP.L / 2) * MAP.k, my = (y) => MAP.oy + (y + MAP.Wd / 2) * MAP.k;
  function pitchLines(ctx) {
    const k = MAP.k; ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 3;
    ctx.strokeRect(mx(-52.5), my(-34), 105 * k, 68 * k);
    ctx.beginPath(); ctx.moveTo(mx(0), my(-34)); ctx.lineTo(mx(0), my(34)); ctx.stroke();
    ctx.beginPath(); ctx.arc(mx(0), my(0), 9.15 * k, 0, Math.PI * 2); ctx.stroke();
    for (const s of [-1, 1]) {
      ctx.strokeRect(s < 0 ? mx(-52.5) : mx(52.5 - 16.5), my(-20.16), 16.5 * k, 40.32 * k);
      ctx.strokeRect(s < 0 ? mx(-52.5) : mx(52.5 - 5.5), my(-9.16), 5.5 * k, 18.32 * k);
    }
  }
  function drawMinimap() {
    const ctx = minimap.getContext('2d'); ctx.fillStyle = '#2E7D4F'; ctx.fillRect(0, 0, minimap.width, minimap.height); pitchLines(ctx);
    ctx.strokeStyle = '#FFB070'; ctx.lineWidth = 6; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.beginPath(); let pen = false;
    for (let f = Math.max(sel.f0, frame - TRAIL_SEC * fps); f <= frame; f += 5) { const q = C.posAt(sel, f); if (!q) { pen = false; continue; } if (pen) ctx.lineTo(mx(q[0]), my(q[1])); else ctx.moveTo(mx(q[0]), my(q[1])); pen = true; }
    ctx.stroke();
    for (const p of players) {
      if (p === sel) continue; const q = C.posAt(p, frame); if (!q) continue; const t = TEAM[p.team];
      ctx.beginPath(); ctx.arc(mx(q[0]), my(q[1]), 11, 0, Math.PI * 2); ctx.fillStyle = t.fill; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = t.stroke; ctx.stroke();
    }
    const q = C.posAt(sel, frame);
    if (q) {
      ctx.beginPath(); ctx.arc(mx(q[0]), my(q[1]), 15, 0, Math.PI * 2); ctx.fillStyle = HI; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#2A1300'; ctx.stroke();
      ctx.font = '700 24px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.lineWidth = 4; ctx.strokeStyle = '#17211C'; ctx.strokeText(sel.name, mx(q[0]), my(q[1]) - 22); ctx.fillStyle = '#FFFFFF'; ctx.fillText(sel.name, mx(q[0]), my(q[1]) - 22); ctx.textAlign = 'start';
    }
  }
  function draw() {
    if (!sel) return; const crop = cropRect();
    if (!$('viewReview').hidden) { drawOverlay(crop); drawFollow(crop); if (src.has_positions) drawMinimap(); }
    $('clock').textContent = C.fmtTime(frame / fps) + ' / ' + C.fmtTime(frames / fps);
    $('tlHead').style.left = (frame / frames * 100) + '%'; $('timeline').setAttribute('aria-valuenow', Math.round(frame / frames * 100));
  }

  // ---------- 선택 ----------
  overlay.addEventListener('click', (e) => {
    const r = overlay.getBoundingClientRect(), vx = (e.clientX - r.left) / r.width * src.clip.width, vy = (e.clientY - r.top) / r.height * src.clip.height;
    const id = C.pickBox(players, frame, vx, vy, 45); if (id != null) select(id);
  });
  minimap.addEventListener('click', (e) => {
    const r = minimap.getBoundingClientRect(), cx = (e.clientX - r.left) / r.width * minimap.width, cy = (e.clientY - r.top) / r.height * minimap.height;
    const id = C.pickDot(players, frame, (cx - MAP.ox) / MAP.k - MAP.L / 2, (cy - MAP.oy) / MAP.k - MAP.Wd / 2, 4); if (id != null) select(id);
  });

  // ---------- 타임라인과 요약 ----------
  function renderTimeline() {
    const seg = $('tlSegments'), marks = $('tlMarks'); seg.textContent = ''; marks.textContent = '';
    for (const [s, e] of sel.segments) { const i = el('i'); i.style.left = (s / frames * 100) + '%'; i.style.width = ((e - s) / frames * 100) + '%'; seg.appendChild(i); }
    for (const j of sel.jumps) { const i = el('i', 'jump'); i.style.left = (j / frames * 100) + '%'; marks.appendChild(i); }
    $('lgJump').hidden = !sel.jumps.length;
    for (const r of sel.fast_runs) { const i = el('i', r.sprint ? 'sprint' : null); i.style.left = (r.start / frames * 100) + '%'; i.style.width = ((r.end - r.start) / frames * 100) + '%'; marks.appendChild(i); }
  }
  $('timeline').addEventListener('click', (e) => { const r = $('timeline').getBoundingClientRect(); seekFrame(Math.floor((e.clientX - r.left) / r.width * frames)); });
  $('timeline').addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') { e.preventDefault(); seekFrame(frame - fps); } if (e.key === 'ArrowRight') { e.preventDefault(); seekFrame(frame + fps); } });
  function renderSummary() {
    $('toReport').textContent = label(sel) + ' 리포트 전체 보기';
    if (!src.has_positions) { $('sumDistLabel').textContent = '기록된 시간'; $('sumDist').textContent = C.fmtTime(sel.observed_sec); return; }
    $('sumDistLabel').textContent = '이동 거리 (' + C.fmtTime(sel.observed_sec) + ' 관측)';
    $('sumDist').textContent = Math.round(sel.distance_m) + ' m'; $('sumTop').textContent = sel.top_speed.toFixed(2) + ' m/s';
    $('sumHsr').textContent = sel.hsr_count + '회 · ' + Math.round(sel.hsr_distance_m) + ' m'; $('sumSprint').textContent = sel.sprint_count + '회';
    $('toReport').textContent = label(sel) + ' 리포트 전체 보기';
  }

  // ---------- 리포트 ----------
  function goScene(f) { setView('review'); seekFrame(f); const p = video.play(); if (p && p.catch) p.catch(() => {}); window.scrollTo({ top: 0 }); }
  function tile(title, value, key, unit, digits, extra) {
    const t = el('div', 'tile'); t.appendChild(el('span', null, title)); t.appendChild(el('b', null, value));
    const group = src.has_identity ? '팀' : '비슷한 길이의 기록', c = C.compare(players, sel, src.has_identity, key);
    const bar = el('div', 'bar'), fill = el('i'), mark = el('u'); fill.style.width = C.clamp(sel[key] / c.max * 100, 0, 100) + '%'; mark.style.left = C.clamp(c.avg / c.max * 100, 0, 100) + '%'; mark.title = group + ' 평균';
    bar.appendChild(fill); if (c.n > 1) bar.appendChild(mark); t.appendChild(bar);
    const diff = c.avg > 0 ? ' (' + (c.diffPct >= 0 ? '+' : '') + Math.round(c.diffPct) + '%)' : '';
    t.appendChild(el('small', null, (c.n > 1 ? group + ' 평균 ' + c.avg.toFixed(digits) + unit + diff : '비교할 대상이 없어요') + (extra ? ' · ' + extra : '')));
    return t;
  }
  function renderReport() {
    if (!src.has_positions) return;      // 경기장을 맞춘 뒤에만 리포트가 열린다
    const P = src.params, group = src.has_identity ? '팀' : '비슷한 길이의 기록';
    $('repClip').textContent = src.clip.label + (src.has_identity ? ' · ' + TEAM[sel.team].name : ' · 추적 결과');
    $('repName').textContent = label(sel) + (src.has_identity ? ' 선수 리포트' : ' 리포트');
    const tt = $('repTitles'); tt.textContent = ''; for (const t of sel.titles) tt.appendChild(el('span', null, t));
    currentAdvice = C.advice(players, sel, src.has_identity, group); $('repAdvice').textContent = currentAdvice.text; $('adviceBtn').hidden = currentAdvice.frame == null;
    const tiles = $('repTiles'); tiles.textContent = '';
    tiles.appendChild(tile('이동 거리', Math.round(sel.distance_m) + ' m', 'distance_m', 'm', 0, C.fmtTime(sel.observed_sec) + ' 관측'));
    tiles.appendChild(tile('평균 속도', sel.avg_speed.toFixed(2) + ' m/s', 'avg_speed', 'm/s', 2));
    tiles.appendChild(tile('최고 속도', sel.top_speed.toFixed(2) + ' m/s', 'top_speed', 'm/s', 2, '시속 ' + (sel.top_speed * 3.6).toFixed(1) + 'km'));
    tiles.appendChild(tile('고속 달리기 (' + P.hsr + ' m/s 이상)', sel.hsr_count + '회 · ' + Math.round(sel.hsr_distance_m) + ' m', 'hsr_count', '회', 1));
    tiles.appendChild(tile('스프린트 (' + P.sprint.toFixed(1) + ' m/s 이상)', sel.sprint_count + '회', 'sprint_count', '회', 1));
    // 활동 구역
    const z = $('zones'); z.textContent = ''; const rows = sel.zone_share.length, cols = sel.zone_share[0].length, cw = 1050 / cols, ch = 680 / rows, zmax = Math.max(1e-9, ...sel.zone_share.flat());
    sel.zone_share.forEach((row, r) => row.forEach((v, c) => {
      z.appendChild(svg('rect', { x: c * cw, y: r * ch, width: cw, height: ch, fill: '#1B6B45', opacity: (v / zmax * 0.9).toFixed(3) }));
      if (v >= 0.05) { const t = svg('text', { x: c * cw + cw / 2, y: r * ch + ch / 2 + 9, 'text-anchor': 'middle', 'font-size': 26, 'font-weight': 700, fill: v / zmax > 0.55 ? '#FFFFFF' : '#17211C' }); t.textContent = Math.round(v * 100) + '%'; z.appendChild(t); }
    }));
    const line = { fill: 'none', stroke: '#55605A', 'stroke-width': 4 };
    z.appendChild(svg('rect', Object.assign({ x: 2, y: 2, width: 1046, height: 676 }, line))); z.appendChild(svg('line', Object.assign({ x1: 525, y1: 2, x2: 525, y2: 678 }, line))); z.appendChild(svg('circle', Object.assign({ cx: 525, cy: 340, r: 91.5 }, line)));
    z.appendChild(svg('rect', Object.assign({ x: 2, y: 138.4, width: 165, height: 403.2 }, line))); z.appendChild(svg('rect', Object.assign({ x: 883, y: 138.4, width: 165, height: 403.2 }, line)));
    // 빠르게 달린 장면
    const runs = $('runs'); runs.textContent = '';
    if (!sel.fast_runs.length) runs.appendChild(el('p', 'empty', '초속 ' + P.hsr + 'm를 ' + P.min_sec + '초 이상 넘긴 장면이 없어요.'));
    for (const r of sel.fast_runs) {
      const b = el('button', 'run-btn'); b.type = 'button'; const s = el('span'); const st = el('strong', null, C.fmtTime(r.start / fps)); s.appendChild(st);
      s.appendChild(document.createTextNode(' · ' + (r.sprint ? '스프린트' : '고속 달리기') + ' ' + Math.round(r.distance_m) + ' m · ' + r.sec.toFixed(1) + '초 · 평균 ' + r.avg.toFixed(1) + ' m/s')); b.appendChild(s); b.appendChild(el('em', null, '장면 보기'));
      b.addEventListener('click', () => goScene(r.start - fps)); runs.appendChild(b);
    }
    // 속도 변화
    const sc = $('speedChart'); sc.textContent = ''; const v = sel.speed_1hz, n = Math.max(2, v.length), X = (i) => i / (n - 1) * 600, Y = (s) => 140 - Math.min(s, 9) / 9 * 130;
    for (const [val, name, col] of [[P.hsr, '고속 달리기 ' + P.hsr + ' m/s', '#B4520F'], [P.sprint, '스프린트 ' + P.sprint.toFixed(1) + ' m/s', '#7A1F0A']]) {
      sc.appendChild(svg('line', { x1: 0, y1: Y(val), x2: 600, y2: Y(val), stroke: col, 'stroke-width': 1.5, 'stroke-dasharray': '6 6' })); const t = svg('text', { x: 596, y: Y(val) - 4, 'text-anchor': 'end', 'font-size': 12, fill: col }); t.textContent = name; sc.appendChild(t);
    }
    let pts = []; const flush = () => { if (pts.length > 1) sc.appendChild(svg('polyline', { points: pts.join(' '), fill: 'none', stroke: '#17211C', 'stroke-width': 2.5, 'stroke-linejoin': 'round' })); pts = []; };
    v.forEach((s, i) => { if (s == null) flush(); else pts.push(X(i).toFixed(1) + ',' + Y(s).toFixed(1)); }); flush();
    const foot = $('repFoot'); foot.textContent = '';
    if (sel.jumps.length) foot.appendChild(el('span', null, '위치가 순간 이동한 지점 ' + sel.jumps.length + '곳(다른 선수로 기록이 넘어간 것으로 추정)의 앞뒤는 거리와 속도 계산에서 뺐어요'));
    for (const t of [src.note, '속도는 위치를 ' + P.smooth_sec + '초 평균한 뒤 계산', '기록이 ' + (P.max_gap / fps) + '초 넘게 끊긴 구간은 거리에 넣지 않음']) foot.appendChild(el('span', null, t));
  }
  $('adviceBtn').addEventListener('click', () => { if (currentAdvice && currentAdvice.frame != null) goScene(currentAdvice.frame); });

  // ---------- 화면 전환 ----------
  function setView(v) {
    const review = v === 'review'; $('viewReview').hidden = !review; $('viewReport').hidden = review;
    $('tabReview').classList.toggle('active', review); $('tabReport').classList.toggle('active', !review);
    if (review) draw(); else video.pause();
  }
  $('tabReview').addEventListener('click', () => setView('review')); $('tabReport').addEventListener('click', () => setView('report'));
  $('toReport').addEventListener('click', () => { setView('report'); window.scrollTo({ top: 0 }); });
  $('sourceSelect').addEventListener('change', (e) => setSource(e.target.value));
  window.addEventListener('resize', draw);

  setSource($('sourceSelect').value); schedule();
  window.TLApp = { select, setView, seekFrame, state: () => ({ source: src.key, selected: sel.id, frame }) };
};
