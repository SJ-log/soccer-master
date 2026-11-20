"""한 영상의 처리 과정을 순서대로 실행하고 진행 상태를 job.json에 남긴다."""
import os, shutil, threading, time, traceback
from pathlib import Path
import numpy as np
from .. import store
from . import probe as PR, package

STEPS = [('probe', '영상 검사'), ('prepare', '재생용 준비'), ('detect', '선수 검출'), ('track', '추적'), ('package', '결과 정리')]
MAX_SEC = float(os.environ.get('TL_MAX_SEC', 600))        # 영상 길이 제한(초)
# 개발용: 검출·추적을 돌릴 수 없는 PC에서 화면을 확인할 때, 미리 만든 추적 결과 파일을 대신 쓴다. 실제 서비스에서는 쓰지 않는다.
DEV_TRACKS = os.environ.get('TL_DEV_TRACKS')
_gpu = threading.Lock()                                    # 한 번에 한 영상만 처리


def _job(video_id, **kw):
    job = store.read(video_id, 'job.json', {}); job.update(kw); store.write(video_id, 'job.json', job); return job


def _step(video_id, key, progress=0.0):
    _job(video_id, state='running', step=key, step_label=dict(STEPS)[key], progress=round(float(progress), 3))


def rebuild(video_id: str) -> dict:
    """추적 결과와 (있다면) 경기장 변환·이은 묶음으로 화면용 결과를 다시 만든다."""
    d = store.video_dir(video_id); meta = store.read(video_id, 'meta.json')
    tracks = np.loadtxt(d / 'tracks.txt', delimiter=',').reshape(-1, 6)
    calib = store.read(video_id, 'calibration.json'); groups = (store.read(video_id, 'players.json') or {}).get('players')
    data = package.build(video_id, meta, tracks, calib, groups); store.write(video_id, 'data.json', data); return data


def process(video_id: str) -> None:
    d = store.video_dir(video_id); meta = store.read(video_id, 'meta.json'); src = d / meta['source']
    _job(video_id, state='queued', step=None, progress=0, error=None, started=time.time(), finished=None,
         steps=[dict(key=k, label=v) for k, v in STEPS])
    with _gpu:
        try:
            _step(video_id, 'probe'); info = PR.probe(src)
            if info['duration'] > MAX_SEC:
                raise ValueError(f"영상이 {info['duration']:.0f}초로 제한({MAX_SEC:.0f}초)보다 깁니다")
            _step(video_id, 'prepare'); play = d / 'video.mp4'
            if PR.browser_playable(info):
                if src.resolve() != play.resolve():
                    shutil.copyfile(src, play)
            else:
                PR.transcode(src, play); info = dict(PR.probe(play), source_codec=info['codec'])
            meta['video'] = info; store.write(video_id, 'meta.json', meta)
            if DEV_TRACKS:
                _step(video_id, 'track'); tracks = np.loadtxt(DEV_TRACKS, delimiter=',').reshape(-1, 6)
                tracks = tracks[tracks[:, 0] < info['frames']]; _job(video_id, dev_tracks=True)
            else:
                from . import detect as DT, track as TR
                _step(video_id, 'detect')
                det, dinfo = DT.detect(play, meta['kind'], lambda done, total: _step(video_id, 'detect', done / max(total, 1)))
                np.savez_compressed(d / 'dets.npz', det=det); _job(video_id, detect=dinfo)
                _step(video_id, 'track')
                tracks = TR.track(det, info['width'], info['height'], info['frames'], lambda done, total: _step(video_id, 'track', done / max(total, 1)))
            np.savetxt(d / 'tracks.txt', tracks, fmt='%d,%d,%.2f,%.2f,%.2f,%.2f')
            _step(video_id, 'package'); data = rebuild(video_id)
            _job(video_id, state='done', step=None, step_label=None, progress=1, finished=time.time(), tracks=len(data['players']))
        except Exception as e:     # 사용자에게 보여줄 한 줄과, 원인을 찾기 위한 기록을 함께 남긴다
            _job(video_id, state='error', error=str(e) or type(e).__name__, trace=traceback.format_exc()[-2000:], finished=time.time())


def start(video_id: str) -> None:
    threading.Thread(target=process, args=(video_id,), daemon=True).start()
