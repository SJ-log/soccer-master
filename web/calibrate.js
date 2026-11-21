// 터치라인 — 경기장 맞추기: 경기장 그림에서 점(또는 선)을 고르고, 영상에서 그 위치를 찍는다.
(async function () {
  'use strict';
  const $ = (id) => document.getElementById(id), NS = 'http://www.w3.org/2000/svg';
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const svg = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
  const fail = (t) => { $('loadError').hidden = false; $('loadError').textContent = t; };
  const id = new URLSearchParams(location.search).get('v');
  if (!id) return fail('영상이 지정되지 않았어요. 영상 목록에서 다시 열어 주세요.');
  const api = '/api/videos/' + encodeURIComponent(id) + '/calibration';
  $('linkWatch').href = 'watch.html?v=' + encodeURIComponent(id);
  let info;
  try { const r = await fetch(api); info = await r.json(); if (!r.ok) return fail(info.error || '영상 정보를 읽지 못했어요.'); } catch (e) { return fail('서버에 연결하지 못했어요.'); }
  const W = info.video.width, H = info.video.height, lmById = Object.fromEntries(info.landmarks.map(l => [l.id, l])), lineById = Object.fromEntries(info.lines.map(l => [l.id, l]));
  const GOOD = { plane: 6, lens: 13 };     // 이만큼 찍기를 권한다(최소는 서버가 알려 주는 min_points)
  const BAD_M = 2.0;                        // 이보다 크게 어긋난 점은 다시 찍으라고 표시

  // ---- 상태 ----
  // points: {key, kind: 'point' | 'line', ref: 점 또는 선의 id, img: [x, y]}
  let points = [], seq = 0, target = null, selected = null, result = null, pendingFit = 0, dirty = false;
  const view = $('view'), ctx = view.getContext('2d'), video = $('video');
  const fit = Math.min(view.width / W, view.height / H); let scale = fit, cx = W / 2, cy = H / 2;
  if (info.saved) {
    for (const p of info.saved.points) {
      if (p.id && lmById[p.id]) points.push({ key: ++seq, kind: 'point', ref: p.id, img: p.img });
      else if (p.line_id && lineById[p.line_id]) points.push({ key: ++seq, kind: 'line', ref: p.line_id, img: p.img });
    }
    result = { overlay: info.saved.overlay, residual_m: info.saved.residual_m, point_errors_m: [], saved: true };
  }
  $('lens').checked = (info.saved ? info.saved.model : info.default_model) === 'lens';
  const model = () => $('lens').checked ? 'lens' : 'plane';
  const known = () => points.filter(p => p.kind === 'point').length;
  const body = (save) => ({ model: model(), save, points: points.map(p => p.kind === 'point' ? { id: p.ref, img: p.img, pitch: lmById[p.ref].pitch } : { line_id: p.ref, img: p.img, line: { axis: lineById[p.ref].axis, value: lineById[p.ref].value } }) });

  // ---- 경기장 그림 ----
  const pitchSvg = $('pitch'), L = info.pitch.length, Wd = info.pitch.width, M = 5;
  pitchSvg.setAttribute('viewBox', [-L / 2 - M, -Wd / 2 - M, L + 2 * M, Wd + 2 * M].join(' '));
  for (const s of info.shapes) pitchSvg.appendChild(svg('polyline', { class: 'ln', points: s.map(p => p.join(',')).join(' ') }));
  for (const l of info.lines) {
    const a = l.axis === 'y' ? [l.span[0], l.value, l.span[1], l.value] : [l.value, l.span[0], l.value, l.span[1]];
    const e = svg('line', { class: 'hit-line', x1: a[0], y1: a[1], x2: a[2], y2: a[3], 'data-line': l.id }); e.appendChild(svg('title', {})).textContent = l.name + ' 위의 아무 곳';
    e.addEventListener('click', () => setTarget({ kind: 'line', ref: l.id })); pitchSvg.appendChild(e);
  }
  for (const l of info.landmarks) {
    const dot = svg('circle', { class: 'lm', cx: l.pitch[0], cy: l.pitch[1], r: 1.5, 'data-lm': l.id }), hit = svg('circle', { class: 'lm-hit', cx: l.pitch[0], cy: l.pitch[1], r: 3.2 });
    hit.appendChild(svg('title', {})).textContent = l.name; hit.addEventListener('click', () => setTarget({ kind: 'point', ref: l.id }));
    pitchSvg.appendChild(dot); pitchSvg.appendChild(hit);
  }
  function setTarget(t) { target = t; selected = null; refresh(); }
  function nextTarget() {       // 점을 찍은 뒤 다음에 찍을 점을 미리 골라 둔다: 아직 안 찍은 점 중 방금 찍은 점에서 가까운 것
    if (!target || target.kind !== 'point') return;
    const cur = lmById[target.ref].pitch, done = new Set(points.filter(p => p.kind === 'point').map(p => p.ref));
    const rest = info.landmarks.filter(l => !done.has(l.id)).sort((a, b) => Math.hypot(a.pitch[0] - cur[0], a.pitch[1] - cur[1]) - Math.hypot(b.pitch[0] - cur[0], b.pitch[1] - cur[1]));
    target = rest.length ? { kind: 'point', ref: rest[0].id } : null;
  }

  // ---- 맞추기 ----
  async function refit() {
    const min = info.min_points[model()], ticket = ++pendingFit;
    if (known() < min) { result = null; return refresh(); }
    try {
      const r = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body(false)) }), j = await r.json();
      if (ticket !== pendingFit) return;       // 그사이 점이 바뀌었으면 버린다
      result = r.ok ? j : { error: j.error || '맞추지 못했어요.' };
    } catch (e) { if (ticket === pendingFit) result = { error: '서버에 연결하지 못했어요.' }; }
    refresh();
  }
  function changed() { dirty = true; $('saveMsg').textContent = ''; refresh(); refit(); }

  // ---- 화면 갱신 ----
  function refresh() {
    const min = info.min_points[model()], good = GOOD[model()], n = known(), nl = points.length - n, donePts = new Set(points.filter(p => p.kind === 'point').map(p => p.ref)), lineHas = new Set(points.filter(p => p.kind === 'line').map(p => p.ref));
    pitchSvg.querySelectorAll('.lm').forEach(e => { const k = e.getAttribute('data-lm'); e.setAttribute('class', 'lm' + (donePts.has(k) ? ' done' : '') + (target && target.kind === 'point' && target.ref === k ? ' active' : '')); });
    pitchSvg.querySelectorAll('.hit-line').forEach(e => { const k = e.getAttribute('data-line'); e.setAttribute('class', 'hit-line' + (lineHas.has(k) ? ' has' : '') + (target && target.kind === 'line' && target.ref === k ? ' active' : '')); });
    $('target').textContent = !target ? '경기장 그림에서 영상에 보이는 점을 하나 눌러 주세요. 선을 누르면 그 선 위의 아무 곳이나 여러 번 찍을 수 있어요.'
      : target.kind === 'point' ? '"' + lmById[target.ref].name + '"을(를) 영상에서 찍어 주세요.' + (donePts.has(target.ref) ? ' (이미 찍은 점: 다시 찍으면 옮겨집니다)' : '')
      : '"' + lineById[target.ref].name + '" 위의 아무 곳이나 찍어 주세요. 여러 번 찍을수록 좋아요.';
    $('counts').textContent = '점 ' + n + '개' + (nl ? ' · 선 위 ' + nl + '개' : '');
    const st = $('status');
    if (n < min) st.textContent = '선이 만나는 점을 ' + (min - n) + '개 더 찍으면 맞춰 볼 수 있어요. (' + good + '개 이상을 권해요)';
    else if (!result) st.textContent = '맞추는 중이에요.';
    else if (result.error) st.textContent = result.error;
    else st.textContent = '찍은 점에서 평균 ' + result.residual_m.mean.toFixed(2) + 'm, 최대 ' + result.residual_m.max.toFixed(2) + 'm 어긋나요. 영상 위의 노란 선이 실제 선과 겹치는지 확대해서 확인해 주세요.' + (n < good ? ' 점을 ' + good + '개 이상 찍으면 더 믿을 수 있어요.' : '');
    const list = $('pointList'); list.textContent = '';
    points.forEach((p, i) => {
      const err = result && result.point_errors_m && result.point_errors_m.length === points.length ? result.point_errors_m[i] : null;
      const li = el('li', (err != null && err > BAD_M ? 'bad ' : '') + (selected === p.key ? 'sel' : '')), b = el('button', 'link-btn', p.kind === 'point' ? lmById[p.ref].name : lineById[p.ref].name + ' 위');
      b.type = 'button'; b.addEventListener('click', () => { selected = p.key; target = null; cx = p.img[0]; cy = p.img[1]; if (scale < 1) scale = 1; refresh(); });
      li.appendChild(b); if (err != null) li.appendChild(document.createTextNode(' · ' + err.toFixed(2) + 'm' + (err > BAD_M ? ' — 다시 확인' : ''))); list.appendChild(li);
    });
    $('delBtn').disabled = selected == null; $('clearBtn').disabled = !points.length;
    $('saveBtn').disabled = !(dirty && result && !result.error && n >= min);
    draw();
  }

  // ---- 영상 그리기 ----
  const toView = (p) => [(p[0] - cx) * scale + view.width / 2, (p[1] - cy) * scale + view.height / 2];
  const toVideo = (x, y) => [(x - view.width / 2) / scale + cx, (y - view.height / 2) / scale + cy];
  function clampView() { scale = Math.min(8, Math.max(fit, scale)); const hw = view.width / 2 / scale, hh = view.height / 2 / scale; cx = hw >= W / 2 ? W / 2 : Math.min(W - hw, Math.max(hw, cx)); cy = hh >= H / 2 ? H / 2 : Math.min(H - hh, Math.max(hh, cy)); }
  function draw() {
    clampView(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#1b2a22'; ctx.fillRect(0, 0, view.width, view.height);
    ctx.setTransform(scale, 0, 0, scale, view.width / 2 - cx * scale, view.height / 2 - cy * scale); ctx.imageSmoothingEnabled = scale < 2;
    try { if (video.readyState >= 2) ctx.drawImage(video, 0, 0, W, H); } catch (e) { /* 영상 준비 전 */ }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (result && result.overlay && $('showLines').checked) {
      ctx.strokeStyle = '#FFE600'; ctx.lineWidth = 2; ctx.globalAlpha = 0.9;
      for (const line of result.overlay) { ctx.beginPath(); line.forEach((p, i) => { const q = toView(p); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
    points.forEach((p, i) => {
      const q = toView(p.img), sel = selected === p.key, err = result && result.point_errors_m && result.point_errors_m.length === points.length ? result.point_errors_m[i] : null;
      ctx.strokeStyle = sel ? '#F28C38' : err != null && err > BAD_M ? '#FF5A5A' : p.kind === 'point' ? '#7BE0A0' : '#9AD0FF'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(q[0], q[1], 9, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(q[0] - 14, q[1]); ctx.lineTo(q[0] - 3, q[1]); ctx.moveTo(q[0] + 3, q[1]); ctx.lineTo(q[0] + 14, q[1]); ctx.moveTo(q[0], q[1] - 14); ctx.lineTo(q[0], q[1] - 3); ctx.moveTo(q[0], q[1] + 3); ctx.lineTo(q[0], q[1] + 14); ctx.stroke();
    });
  }

  // ---- 조작 ----
  const evPos = (e) => { const r = view.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * view.width, (e.clientY - r.top) / r.height * view.height]; };
  function zoomAt(x, y, k) { const before = toVideo(x, y); scale = Math.min(8, Math.max(fit, scale * k)); cx = before[0] - (x - view.width / 2) / scale; cy = before[1] - (y - view.height / 2) / scale; draw(); }
  view.addEventListener('wheel', (e) => { e.preventDefault(); const p = evPos(e); zoomAt(p[0], p[1], e.deltaY < 0 ? 1.25 : 0.8); }, { passive: false });
  let drag = null;
  view.addEventListener('pointerdown', (e) => { drag = { start: evPos(e), cx, cy, moved: false }; view.setPointerCapture(e.pointerId); });
  view.addEventListener('pointermove', (e) => { if (!drag) return; const p = evPos(e), dx = p[0] - drag.start[0], dy = p[1] - drag.start[1]; if (Math.hypot(dx, dy) > 5) drag.moved = true; if (drag.moved) { cx = drag.cx - dx / scale; cy = drag.cy - dy / scale; draw(); } });
  view.addEventListener('pointerup', (e) => {
    const d = drag; drag = null; if (!d || d.moved) return;
    const p = evPos(e), v = toVideo(p[0], p[1]);
    const near = points.find(q => { const s = toView(q.img); return Math.hypot(s[0] - p[0], s[1] - p[1]) < 12; });
    if (near && !target) { selected = near.key; return refresh(); }                    // 찍은 점 고르기
    if (!target) { $('target').textContent = '먼저 경기장 그림에서 어느 점인지 골라 주세요.'; return; }
    if (v[0] < 0 || v[1] < 0 || v[0] > W || v[1] > H) return;
    const img = [Math.round(v[0] * 10) / 10, Math.round(v[1] * 10) / 10];
    if (target.kind === 'point') { points = points.filter(q => !(q.kind === 'point' && q.ref === target.ref)); const np = { key: ++seq, kind: 'point', ref: target.ref, img }; points.push(np); selected = np.key; nextTarget(); }
    else { const np = { key: ++seq, kind: 'line', ref: target.ref, img }; points.push(np); selected = np.key; }
    changed();
  });
  window.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    const p = points.find(q => q.key === selected); if (!p) return;
    const step = e.shiftKey ? 5 : 1, d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) { e.preventDefault(); p.img = [p.img[0] + d[0], p.img[1] + d[1]]; changed(); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); points = points.filter(q => q.key !== selected); selected = null; changed(); }
  });
  $('zoomIn').addEventListener('click', () => zoomAt(view.width / 2, view.height / 2, 1.5));
  $('zoomOut').addEventListener('click', () => zoomAt(view.width / 2, view.height / 2, 1 / 1.5));
  $('zoomFit').addEventListener('click', () => { scale = fit; draw(); });
  $('showLines').addEventListener('change', draw);
  $('lens').addEventListener('change', changed);
  $('delBtn').addEventListener('click', () => { points = points.filter(q => q.key !== selected); selected = null; changed(); });
  $('clearBtn').addEventListener('click', () => { points = []; selected = null; result = null; changed(); });
  $('time').addEventListener('input', () => { if (video.duration) video.currentTime = (info.video.t0 || 0) + ($('time').value / 1000) * Math.max(0, video.duration - (info.video.t0 || 0) - 0.1); });
  $('saveBtn').addEventListener('click', async () => {
    $('saveBtn').disabled = true; $('saveMsg').textContent = '저장하고 거리·속도를 다시 계산하는 중이에요.';
    try {
      const r = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body(true)) }), j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      result = j; dirty = false; $('saveMsg').textContent = '저장했어요. 복기 화면에 미니맵과 리포트가 열립니다.'; refresh();
    } catch (e) { $('saveMsg').textContent = '저장하지 못했어요: ' + e.message; $('saveBtn').disabled = false; }
  });
  video.addEventListener('loadeddata', () => { video.currentTime = (info.video.t0 || 0) + 0.05; }); video.addEventListener('seeked', draw);
  video.addEventListener('error', () => fail('영상 파일을 열지 못했어요.'));
  video.src = info.video.url;
  window.TLCal = { state: () => ({ points, target, selected, result, scale, cx, cy, model: model(), dirty }), setTarget, toView, zoomAt };
  refresh(); if (points.length) refit().then(() => { dirty = false; refresh(); });
})();
