// 터치라인 — 기록 잇기: 끊기거나 다른 선수로 넘어간 기록을 사용자가 이어서 한 선수의 기록으로 만든다.
(async function () {
  'use strict';
  const C = window.TLCore, S = C.stitch, $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fail = (t) => { $('loadError').hidden = false; $('loadError').textContent = t; };
  const id = new URLSearchParams(location.search).get('v');
  if (!id) return fail('영상이 지정되지 않았어요. 영상 목록에서 다시 열어 주세요.');
  $('linkWatch').href = 'watch.html?v=' + encodeURIComponent(id);
  let data, saved;
  try {
    const r = await fetch('/api/videos/' + encodeURIComponent(id) + '/data'); if (!r.ok) return fail((await r.json()).error || '처리 결과를 읽지 못했어요.');
    data = await r.json(); saved = await (await fetch('/api/videos/' + encodeURIComponent(id) + '/players')).json();
  } catch (e) { return fail('서버에 연결하지 못했어요.'); }
  const tracks = data.players.filter(p => p.kind === 'track'), byId = Object.fromEntries(tracks.map(t => [t.id, t]));
  if (!tracks.length) return fail('이 영상에서는 추적된 기록이 없어요.');
  const clip = data.clip, fps = clip.fps, frames = clip.frames, W = clip.width, H = clip.height;
  const CROP = [Math.min(640, W), Math.min(360, H)], HI = '#F28C38', CAND = '#FFD400', OTHER = 'rgba(255,255,255,.85)';
  const video = $('video'), overlay = $('overlay'), zoom = $('zoom');
  $('videoWrap').style.aspectRatio = W + '/' + H; overlay.width = Math.min(W, 2048); overlay.height = Math.round(overlay.width * H / W);
  video.src = clip.video;

  // ---- 상태 ----
  let parts = [], history = [], pending = null, rejected = new Set(), frame = 0, center = [W / 2, H / 2], crossings = [], dirty = false;
  const first = (saved.players || [])[0];
  if (first && Array.isArray(first.parts)) {       // 저장된 기록 불러오기: 생략된 구간은 그 기록의 처음·끝으로 채운다
    parts = first.parts.filter(p => byId[p.track]).map(p => ({ track: p.track, from: Math.max(p.from == null ? 0 : p.from, byId[p.track].f0), to: Math.min(p.to == null ? 1e9 : p.to, byId[p.track].f0 + byId[p.track].n - 1) })).filter(p => p.from <= p.to);
    $('name').value = first.name || '나';
  }
  const time = (f) => C.fmtTime(f / fps), label = (tid) => '기록 #' + tid;
  const seek = (f) => { f = C.clamp(Math.round(f), 0, frames - 1); video.currentTime = (clip.t0 || 0) + (f + 0.5) / fps; frame = f; };
  const pause = () => { if (!video.paused) video.pause(); };
  function apply(next) { history.push(parts); parts = next; pending = null; rejected = new Set(); dirty = true; refresh(); }

  // ---- 후보 ----
  function candidates() {
    if (!parts.length) return { dir: 0, list: [] };
    const [a, b] = S.range(parts);
    if (b < frames - 2) { const list = S.candidates(tracks, byId, parts, 1, fps, 8).filter(c => !rejected.has(c.track)); if (list.length || a <= 1) return { dir: 1, list: list.slice(0, 4) }; }
    if (a > 1) return { dir: -1, list: S.candidates(tracks, byId, parts, -1, fps, 8).filter(c => !rejected.has(c.track)).slice(0, 4) };
    return { dir: 0, list: [] };
  }
  function propose(c, dir) { pause(); pending = { track: c.track, frame: c.frame, dir }; seek(c.frame); refresh(); }

  // ---- 화면 갱신 ----
  function refresh() {
    crossings = parts.length ? S.crossings(tracks, byId, parts, 0.2, fps) : [];
    const range = S.range(parts), cand = candidates(), cb = $('cands'); cb.textContent = '';
    $('confirm').hidden = !pending;
    if (pending) {
      $('confirmText').textContent = pending.dir === 0 ? (parts.length ? time(pending.frame) + '부터 ' + label(pending.track) + '(노란 박스)이 나인가요?' : label(pending.track) + '(노란 박스)이 나인가요?')
        : pending.dir > 0 ? '끊긴 뒤에 나타난 ' + label(pending.track) + '(노란 박스)이 나인가요?' : '내 기록 앞의 ' + label(pending.track) + '(노란 박스)이 나인가요?';
      $('todo').textContent = '노란 박스를 확인해 주세요. 재생해서 앞뒤를 봐도 됩니다.';
    } else if (!parts.length) {
      $('todo').textContent = '자기가 잘 보이는 장면에서 멈추고, 전체 영상이나 확대 화면에서 자기 박스를 눌러 주세요.';
    } else if (cand.list.length) {
      $('todo').textContent = cand.dir > 0 ? '내 기록이 ' + time(range[1]) + '에서 끊겼어요. 이어질 후보를 가까운 순서로 골랐어요.' : '내 기록이 ' + time(range[0]) + '에 시작해요. 그 앞에 이어질 후보가 있어요.';
      cand.list.forEach((c, i) => { const b = el('button', 'btn cand-btn', '후보 ' + (i + 1) + ' · ' + (c.dt / fps).toFixed(1) + '초 ' + (cand.dir > 0 ? '뒤' : '앞')); b.type = 'button'; b.addEventListener('click', () => propose(c, cand.dir)); cb.appendChild(b); });
    } else if (range[1] < frames - 2 || range[0] > 1) {
      $('todo').textContent = '가까이에 이어질 후보가 없어요. ' + (range[1] < frames - 2 ? time(range[1]) + ' 뒤' : time(range[0]) + ' 앞') + '에서 자기가 다시 보이면 그 박스를 직접 눌러 주세요.';
    } else {
      $('todo').textContent = '처음부터 끝까지 이었어요. "확인할 곳"을 살펴본 뒤 저장해 주세요.';
    }
    const list = $('partList'); list.textContent = '';
    for (const p of parts) { const li = el('li'), b = el('button', 'link-btn', time(p.from) + ' ~ ' + time(p.to)); b.type = 'button'; b.addEventListener('click', () => { pause(); seek(p.from); }); li.appendChild(b); li.appendChild(document.createTextNode(' · ' + label(p.track))); list.appendChild(li); }
    const sec = parts.reduce((a, p) => a + (p.to - p.from + 1), 0) / fps;
    $('chainInfo').textContent = parts.length ? '조각 ' + parts.length + '개 · ' + C.fmtTime(sec) + ' / ' + C.fmtTime(frames / fps) : '';
    $('crossCount').textContent = crossings.length ? crossings.length + '곳' : (parts.length ? '없음' : '');
    $('prevCross').disabled = $('nextCross').disabled = !crossings.length;
    $('undoBtn').disabled = !history.length; $('resetBtn').disabled = !parts.length; $('saveBtn').disabled = !parts.length || !dirty;
    const seg = $('tlSegments'), marks = $('tlMarks'); seg.textContent = ''; marks.textContent = '';
    for (const p of parts) { const i = el('i'); i.style.left = (p.from / frames * 100) + '%'; i.style.width = ((p.to - p.from + 1) / frames * 100) + '%'; seg.appendChild(i); }
    for (const c of crossings) { const i = el('i'); i.style.left = (c.start / frames * 100) + '%'; i.style.width = ((c.end - c.start + 1) / frames * 100) + '%'; marks.appendChild(i); }
    draw();
  }

  // ---- 그리기 ----
  function focusBox() {      // 확대 화면이 따라갈 박스: 확인 중인 후보 > 내 박스
    if (pending) { const b = C.boxAt(byId[pending.track], frame); if (b) return b; }
    const m = S.chainBox(parts, byId, frame); return m ? m.box : null;
  }
  function draw() {
    const mine = S.chainBox(parts, byId, frame), fb = focusBox();
    if (fb) center = [fb[0] + fb[2] / 2, fb[1] + fb[3] / 2];
    const crop = [C.clamp(center[0] - CROP[0] / 2, 0, W - CROP[0]), C.clamp(center[1] - CROP[1] / 2, 0, H - CROP[1]), CROP[0], CROP[1]];
    $('cutBtn').disabled = !mine || !!pending;
    // 확대 화면
    const z = zoom.getContext('2d'), k = zoom.width / CROP[0]; z.fillStyle = '#264a37'; z.fillRect(0, 0, zoom.width, zoom.height);
    try { if (video.readyState >= 2) z.drawImage(video, crop[0], crop[1], crop[2], crop[3], 0, 0, zoom.width, zoom.height); } catch (e) { /* 영상 준비 전 */ }
    // 전체 영상
    const o = overlay.getContext('2d'), s = overlay.width / W; o.clearRect(0, 0, overlay.width, overlay.height);
    o.setLineDash([6, 4]); o.strokeStyle = HI; o.lineWidth = 1.5; o.strokeRect(crop[0] * s, crop[1] * s, crop[2] * s, crop[3] * s); o.setLineDash([]);
    for (const t of tracks) {
      const b = C.boxAt(t, frame); if (!b) continue;
      const isMine = mine && mine.track === t.id, isCand = pending && pending.track === t.id, color = isCand ? CAND : isMine ? HI : OTHER;
      o.strokeStyle = color; o.lineWidth = isMine || isCand ? 3 : 1; o.strokeRect(b[0] * s, b[1] * s, b[2] * s, b[3] * s);
      if (b[0] + b[2] < crop[0] || b[0] > crop[0] + crop[2] || b[1] + b[3] < crop[1] || b[1] > crop[1] + crop[3]) continue;
      const x = (b[0] - crop[0]) * k, y = (b[1] - crop[1]) * k; z.strokeStyle = color; z.lineWidth = isMine || isCand ? 4 : 1.5; z.strokeRect(x, y, b[2] * k, b[3] * k);
      if (isMine || isCand) {
        const text = isCand ? '이 선수?' : ($('name').value || '나'); z.font = '700 20px sans-serif'; const tw = z.measureText(text).width + 14, tx = C.clamp(x + b[2] * k / 2 - tw / 2, 0, zoom.width - tw), ty = Math.max(0, y - 34);
        z.fillStyle = color; z.fillRect(tx, ty, tw, 28); z.fillStyle = '#2A1300'; z.textBaseline = 'middle'; z.fillText(text, tx + 7, ty + 15);
      }
    }
    const msg = $('zoomMsg'); msg.hidden = !!mine || !!pending || !parts.length; if (!msg.hidden) msg.textContent = '이 구간에는 내 기록이 없어요';
    $('zoomTitle').textContent = '확대 화면 · ' + time(frame);
    $('clock').textContent = time(frame) + ' / ' + C.fmtTime(frames / fps); $('tlHead').style.left = (frame / frames * 100) + '%';
    $('playBtn').textContent = video.paused ? '재생' : '멈춤';
  }
  function tick() { const f = C.frameAt(video.currentTime, fps, frames, clip.t0); if (f !== frame || !video.paused) { frame = f; draw(); } requestAnimationFrame(tick); }

  // ---- 고르기 ----
  function pick(tid) {
    if (tid == null) return; pause();
    const mine = S.chainBox(parts, byId, frame);
    if (mine && mine.track === tid) return;                         // 이미 내 박스
    pending = { track: tid, frame, dir: 0 }; refresh();
  }
  function accept() {
    const p = pending; if (!p) return;
    if (!parts.length) return apply(S.continueFrom([], byId, byId[p.track].f0, p.track));       // 처음 고른 기록은 통째로 쓰고, 확인할 곳에서 다듬는다
    const [a] = S.range(parts);
    if (p.frame < a) return apply(S.prepend(parts, byId, p.track));
    const [, end] = S.range(parts), t0 = byId[p.track].f0;
    apply(S.continueFrom(parts, byId, p.frame > end && t0 > end ? t0 : p.frame, p.track));     // 내 기록이 끝난 뒤에 새로 생긴 기록이면 그 기록의 처음부터 쓴다
  }
  overlay.addEventListener('click', (e) => { const r = overlay.getBoundingClientRect(); pick(C.pickBox(tracks, frame, (e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H, 45)); });
  zoom.addEventListener('click', (e) => {
    const r = zoom.getBoundingClientRect(), crop = [C.clamp(center[0] - CROP[0] / 2, 0, W - CROP[0]), C.clamp(center[1] - CROP[1] / 2, 0, H - CROP[1])];
    pick(C.pickBox(tracks, frame, crop[0] + (e.clientX - r.left) / r.width * CROP[0], crop[1] + (e.clientY - r.top) / r.height * CROP[1], 12));
  });
  $('yesBtn').addEventListener('click', accept);
  $('noBtn').addEventListener('click', () => { if (pending && pending.dir !== 0) rejected.add(pending.track); pending = null; refresh(); });
  $('cutBtn').addEventListener('click', () => { pause(); apply(S.cut(parts, frame)); });
  $('undoBtn').addEventListener('click', () => { if (history.length) { parts = history.pop(); pending = null; rejected = new Set(); dirty = true; refresh(); } });
  $('resetBtn').addEventListener('click', () => apply([]));
  function jump(dir) {
    if (!crossings.length) return; pause();
    const c = dir > 0 ? crossings.find(x => x.start - fps > frame) || crossings[0] : [...crossings].reverse().find(x => x.start - fps < frame - 1) || crossings[crossings.length - 1];
    seek(c.start - fps);      // 겹치기 1초 전부터 보여준다
  }
  $('nextCross').addEventListener('click', () => jump(1)); $('prevCross').addEventListener('click', () => jump(-1));
  $('playBtn').addEventListener('click', () => { if (video.paused) video.play(); else video.pause(); });
  $('rate').addEventListener('change', () => { video.playbackRate = Number($('rate').value); });
  $('timeline').addEventListener('click', (e) => { const r = $('timeline').getBoundingClientRect(); seek(Math.floor((e.clientX - r.left) / r.width * frames)); });
  $('timeline').addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') { e.preventDefault(); seek(frame - fps); } if (e.key === 'ArrowRight') { e.preventDefault(); seek(frame + fps); } });
  $('name').addEventListener('input', () => { dirty = true; $('saveBtn').disabled = !parts.length; draw(); });
  $('saveBtn').addEventListener('click', async () => {
    $('saveBtn').disabled = true; $('saveMsg').textContent = '저장하는 중이에요.';
    try {
      const r = await fetch('/api/videos/' + encodeURIComponent(id) + '/players', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ players: [{ name: ($('name').value || '나').trim() || '나', parts }] }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status);
      dirty = false; $('saveMsg').textContent = '저장했어요. 복기 화면의 첫 번째 선수로 나옵니다.';
    } catch (e) { $('saveMsg').textContent = '저장하지 못했어요: ' + e.message; $('saveBtn').disabled = false; }
  });
  video.addEventListener('loadeddata', draw); video.addEventListener('seeked', draw); video.addEventListener('pause', draw); video.addEventListener('play', draw);
  video.addEventListener('error', () => fail('영상 파일을 열지 못했어요.'));
  window.TLStitch = { state: () => ({ parts, pending, frame, crossings, cands: candidates() }), seek, pick, accept };
  dirty = false; refresh(); requestAnimationFrame(tick);
})();
