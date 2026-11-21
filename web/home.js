// 영상 올리기와 처리 상태 목록
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const STATE = { queued: '대기 중', running: '처리 중', done: '완료', error: '오류' };
  let limits = { max_sec: 600, max_mb: 2048 };
  // 올리기 전에 브라우저에서 영상 길이를 읽는다(읽지 못하는 형식이면 null: 그때는 서버가 확인한다)
  const durationOf = (file) => new Promise((res) => { const v = document.createElement('video'), url = URL.createObjectURL(file), done = (d) => { URL.revokeObjectURL(url); res(d); }; v.preload = 'metadata'; v.onloadedmetadata = () => done(isFinite(v.duration) ? v.duration : null); v.onerror = () => done(null); setTimeout(() => done(null), 5000); v.src = url; });

  function item(v) {
    const job = v.job || {}, box = el('div', 'item'), left = el('div'), links = el('div', 'links');
    const h = el('h3', null, v.name + ' '); h.appendChild(el('span', 'badge ' + (job.state || ''), STATE[job.state] || '준비 중')); left.appendChild(h);
    const info = v.video ? v.video.width + '×' + v.video.height + ' · ' + Math.round(v.video.duration) + '초 · ' : '';
    let line = info + (v.kind === 'panorama' ? '파노라마' : '스마트폰') + ' · 경기장 ' + v.pitch.length + '×' + v.pitch.width + 'm';
    if (job.state === 'running') line = (job.step_label || '') + ' ' + Math.round((job.progress || 0) * 100) + '% · ' + line;
    if (job.state === 'error') line = '오류: ' + job.error;
    if (job.dev_tracks) line += ' · 개발용 추적 결과 사용';
    left.appendChild(el('p', null, line));
    if (job.state === 'running') { const p = el('div', 'progress'), i = el('i'); i.style.width = Math.round((job.progress || 0) * 100) + '%'; p.appendChild(i); left.appendChild(p); }
    box.appendChild(left);
    if (job.state === 'done') for (const [href, text] of [['watch.html', '복기 화면'], ['stitch.html', '기록 잇기'], ['calibrate.html', '경기장 맞추기']]) {
      const a = el('a', 'tab', text); a.href = href + '?v=' + encodeURIComponent(v.id); links.appendChild(a);
    }
    box.appendChild(links); return box;
  }
  async function refresh() {
    try {
      const r = await fetch('/api/videos'); const { videos, limits: lim } = await r.json(); const list = $('videoList'); list.textContent = '';
      if (lim) { limits = lim; $('uploadHint').textContent = '고정된 카메라로 찍은 영상 · mp4, mov · ' + Math.round(lim.max_sec / 60) + '분 이내'; }
      if (!videos.length) list.appendChild(el('p', 'empty', '아직 올린 영상이 없어요.'));
      for (const v of videos) list.appendChild(item(v));
      return videos.some(v => v.job && (v.job.state === 'running' || v.job.state === 'queued'));
    } catch (e) { $('uploadMsg').textContent = '서버에 연결하지 못했어요.'; return false; }
  }
  async function loop() { const busy = await refresh(); setTimeout(loop, busy ? 1500 : 6000); }

  $('uploadForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const btn = $('uploadBtn'), file = $('file').files[0]; if (!file) return;
    btn.disabled = true; $('uploadMsg').textContent = '영상을 확인하는 중이에요.';
    if (file.size > limits.max_mb * 1e6) { $('uploadMsg').textContent = '파일이 ' + Math.round(file.size / 1e6) + 'MB예요. ' + Math.round(limits.max_mb) + 'MB까지 올릴 수 있어요.'; btn.disabled = false; return; }
    const dur = await durationOf(file);
    if (dur != null && dur > limits.max_sec) { $('uploadMsg').textContent = '영상이 ' + Math.floor(dur / 60) + '분 ' + Math.round(dur % 60) + '초예요. ' + Math.round(limits.max_sec / 60) + '분 이내로 잘라서 올려 주세요.'; btn.disabled = false; return; }
    $('uploadMsg').textContent = '올리는 중이에요. 파일이 크면 시간이 걸려요.';
    try {
      const r = await fetch('/api/videos', { method: 'POST', body: new FormData($('uploadForm')) }); const j = await r.json();
      $('uploadMsg').textContent = r.ok ? '올렸어요. 처리를 시작했습니다.' : '올리지 못했어요: ' + (j.error || r.status);
      if (r.ok) $('uploadForm').reset();
    } catch (err) { $('uploadMsg').textContent = '올리지 못했어요. 서버 연결을 확인해 주세요.'; }
    btn.disabled = false; refresh();
  });
  loop();
})();
