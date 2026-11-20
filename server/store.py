"""영상별 폴더에 파일로 저장한다. DB 없음.

data/videos/<id>/
  source.<확장자>   올린 원본
  video.mp4         브라우저 재생용(원본이 H.264면 원본을 그대로 가리킴)
  meta.json         이름, 영상 종류, 경기장 규격, 영상 정보
  job.json          처리 상태
  dets.npz          검출 결과
  tracks.txt        추적 결과 (frame, id, x, y, w, h)
  calibration.json  사용자가 찍은 경기장 점
  players.json      사용자가 이은 기록 묶음
  data.json         화면에 보내는 결과
"""
import json, os, re, time, uuid
from pathlib import Path

DATA = Path(os.environ.get('TL_DATA', Path(__file__).resolve().parent.parent / 'data'))
ID_RE = re.compile(r'^[a-z0-9]{8,32}$')


def video_dir(video_id: str) -> Path:
    if not ID_RE.match(video_id):
        raise KeyError(video_id)
    return DATA / 'videos' / video_id


def new_video() -> tuple[str, Path]:
    video_id = time.strftime('%m%d') + uuid.uuid4().hex[:8]
    d = DATA / 'videos' / video_id
    d.mkdir(parents=True)
    return video_id, d


def read(video_id: str, name: str, default=None):
    p = video_dir(video_id) / name
    if not p.exists():
        return default
    return json.loads(p.read_text(encoding='utf-8'))


def write(video_id: str, name: str, obj) -> None:
    p = video_dir(video_id) / name
    tmp = p.with_suffix(p.suffix + '.tmp')
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding='utf-8')
    tmp.replace(p)      # 읽는 쪽이 반쯤 쓰인 파일을 보지 않게 한다


def list_videos() -> list[dict]:
    root = DATA / 'videos'
    out = []
    if root.exists():
        for d in sorted(root.iterdir(), reverse=True):
            if d.is_dir() and ID_RE.match(d.name) and (d / 'meta.json').exists():
                out.append(dict(read(d.name, 'meta.json'), job=read(d.name, 'job.json', {})))
    return out
