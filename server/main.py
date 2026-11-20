"""터치라인 서버: 영상 접수, 처리 상태, 결과 전달, 화면 파일 제공.

실행: uvicorn server.main:app --host 0.0.0.0 --port 8000
"""
import os
from pathlib import Path
from starlette.applications import Starlette
from starlette.responses import JSONResponse, FileResponse
from starlette.routing import Route, Mount
from starlette.staticfiles import StaticFiles
from . import store
from .pipeline import run, positions

WEB = Path(__file__).resolve().parent.parent / 'web'
KINDS = ('panorama', 'phone')
EXTS = ('.mp4', '.mov', '.m4v')
MAX_MB = float(os.environ.get('TL_MAX_MB', 2048))


def err(message: str, status: int = 400):
    return JSONResponse(dict(error=message), status_code=status)


def _summary(video_id: str) -> dict:
    meta = store.read(video_id, 'meta.json')
    return dict(meta, job=store.read(video_id, 'job.json', {}), calibrated=store.read(video_id, 'calibration.json') is not None,
                my_players=len((store.read(video_id, 'players.json') or {}).get('players', [])))


async def list_videos(request):
    return JSONResponse(dict(videos=store.list_videos()))


async def upload(request):
    form = await request.form()
    file = form.get('file')
    if file is None or not getattr(file, 'filename', ''):
        return err('영상 파일을 골라 주세요')
    ext = Path(file.filename).suffix.lower()
    if ext not in EXTS:
        return err(f'지원하는 형식은 {", ".join(EXTS)} 입니다')
    kind = form.get('kind') or 'panorama'
    if kind not in KINDS:
        return err('영상 종류가 올바르지 않습니다')
    try:
        length, width = float(form.get('pitch_length') or 105), float(form.get('pitch_width') or 68)
    except ValueError:
        return err('경기장 규격은 숫자로 입력해 주세요')
    if not (20 <= length <= 130 and 15 <= width <= 100):
        return err('경기장 규격이 범위를 벗어났습니다 (길이 20~130m, 폭 15~100m)')
    video_id, d = store.new_video(); size = 0
    with open(d / f'source{ext}', 'wb') as out:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > MAX_MB * 1e6:
                out.close(); (d / f'source{ext}').unlink(); d.rmdir()
                return err(f'파일이 {MAX_MB:.0f}MB보다 큽니다', 413)
            out.write(chunk)
    name = (form.get('name') or Path(file.filename).stem)[:80]
    store.write(video_id, 'meta.json', dict(id=video_id, name=name, kind=kind, source=f'source{ext}', size_mb=round(size / 1e6, 1),
                                           pitch=dict(length=length, width=width)))
    run.start(video_id)
    return JSONResponse(_summary(video_id), status_code=201)


async def get_video(request):
    try:
        return JSONResponse(_summary(request.path_params['id']))
    except (KeyError, TypeError):
        return err('영상을 찾을 수 없습니다', 404)


async def get_data(request):
    try:
        p = store.video_dir(request.path_params['id']) / 'data.json'
    except KeyError:
        return err('영상을 찾을 수 없습니다', 404)
    if not p.exists():
        return err('아직 처리 결과가 없습니다', 404)
    return FileResponse(p, media_type='application/json')


async def media(request):
    try:
        p = store.video_dir(request.path_params['id']) / 'video.mp4'
    except KeyError:
        return err('영상을 찾을 수 없습니다', 404)
    if not p.exists():
        return err('재생용 영상이 아직 없습니다', 404)
    return FileResponse(p, media_type='video/mp4')       # 구간 요청(Range)을 지원해 탐색이 된다


async def set_calibration(request):
    """경기장 점을 받아 변환을 맞추고 결과를 다시 만든다. body: {"points": [{"img": [x, y], "pitch": [X, Y]}, ...]}"""
    video_id = request.path_params['id']
    try:
        body = await request.json(); calib = positions.fit(body.get('points') or [])
        calib['points_raw'] = body['points']; store.write(video_id, 'calibration.json', calib); data = run.rebuild(video_id)
    except KeyError:
        return err('영상을 찾을 수 없습니다', 404)
    except (ValueError, TypeError) as e:
        return err(str(e))
    return JSONResponse(dict(residual_m=calib['residual_m'], points=calib['points'], has_positions=data['has_positions']))


async def get_players(request):
    """저장된 기록 묶음(없으면 빈 목록)"""
    try:
        return JSONResponse(store.read(request.path_params['id'], 'players.json') or dict(players=[]))
    except KeyError:
        return err('영상을 찾을 수 없습니다', 404)


async def set_players(request):
    """사용자가 이은 기록 묶음을 저장하고 지표를 다시 계산한다.
    body: {"players": [{"name": "나", "parts": [{"track": 12, "from": 0, "to": 900}, ...]}]}"""
    video_id = request.path_params['id']
    try:
        body = await request.json(); players = body.get('players')
        if not isinstance(players, list) or len(players) > 50:
            return err('players 목록이 올바르지 않습니다')
        for p in players:
            if not isinstance(p.get('parts'), list) or not all(isinstance(x.get('track'), int) for x in p['parts']):
                return err('각 선수에는 parts(기록 번호와 구간)가 필요합니다')
        store.write(video_id, 'players.json', dict(players=players)); data = run.rebuild(video_id)
    except KeyError:
        return err('영상을 찾을 수 없습니다', 404)
    except (ValueError, TypeError, AttributeError) as e:
        return err(str(e) or '요청 형식이 올바르지 않습니다')
    return JSONResponse(dict(my_players=sum(1 for p in data['players'] if p['kind'] == 'player')))


app = Starlette(routes=[
    Route('/api/videos', list_videos, methods=['GET']),
    Route('/api/videos', upload, methods=['POST']),
    Route('/api/videos/{id}', get_video, methods=['GET']),
    Route('/api/videos/{id}/data', get_data, methods=['GET']),
    Route('/api/videos/{id}/calibration', set_calibration, methods=['POST']),
    Route('/api/videos/{id}/players', get_players, methods=['GET']),
    Route('/api/videos/{id}/players', set_players, methods=['POST']),
    Route('/media/{id}/video.mp4', media, methods=['GET']),
    Mount('/', StaticFiles(directory=WEB, html=True)),
])
