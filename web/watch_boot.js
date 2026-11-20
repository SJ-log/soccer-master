// 주소의 ?v=<영상 id>로 처리 결과를 받아 복기 화면을 시작한다.
(async function () {
  const id = new URLSearchParams(location.search).get('v'), show = (t) => { const e = document.getElementById('loadError'); e.hidden = false; e.textContent = t; };
  if (!id) return show('영상이 지정되지 않았어요. 영상 목록에서 다시 열어 주세요.');
  for (const a of ['linkStitch', 'linkCalib', 'hintCalib']) { const e = document.getElementById(a); e.href = e.getAttribute('href') + '?v=' + encodeURIComponent(id); }
  try {
    const r = await fetch('/api/videos/' + encodeURIComponent(id) + '/data');
    if (!r.ok) return show((await r.json()).error || '처리 결과를 읽지 못했어요.');
    const data = await r.json(); if (!data.players.length) return show('이 영상에서는 추적된 기록이 없어요.');
    window.TL_SOURCES = { track: data }; window.TLStart();
  } catch (e) { show('서버에 연결하지 못했어요.'); }
})();
