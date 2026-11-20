// 영상 올리기와 처리 상태 목록
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const STATE = { queued: '대기 중', running: '처리 중', done: '완료', error: '오류' };

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
      const r = await fetch('/api/videos'); const { videos } = await r.json(); const list = $('videoList'); list.textContent = '';
      if (!videos.length) list.appendChild(el('p', 'empty', '아직 올린 영상이 없어요.'));
      for (const v of videos) list.appendChild(item(v));
      return videos.some(v => v.job && (v.job.state === 'running' || v.job.state === 'queued'));
    } catch (e) { $('uploadMsg').textContent = '서버에 연결하지 못했어요.'; return false; }
  }
  async function loop() { const busy = await refresh(); setTimeout(loop, busy ? 1500 : 6000); }

  $('uploadForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const btn = $('uploadBtn'); btn.disabled = true; $('uploadMsg').textContent = '올리는 중이에요. 파일이 크면 시간이 걸려요.';
    try {
      const r = await fetch('/api/videos', { method: 'POST', body: new FormData($('uploadForm')) }); const j = await r.json();
      $('uploadMsg').textContent = r.ok ? '올렸어요. 처리를 시작했습니다.' : '올리지 못했어요: ' + (j.error || r.status);
      if (r.ok) $('uploadForm').reset();
    } catch (err) { $('uploadMsg').textContent = '올리지 못했어요. 서버 연결을 확인해 주세요.'; }
    btn.disabled = false; refresh();
  });
  loop();
})();
