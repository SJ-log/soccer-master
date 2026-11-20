"""추적 결과(+ 경기장 변환, + 사용자가 이은 묶음)를 화면이 읽는 형식으로 묶는다.

화면 형식은 프로토타입_v2의 data_*.js와 같다. 경기장 변환이 없으면 위치(pos)와 지표 없이 박스만 보낸다.
"""
import numpy as np
from . import metrics as M, positions as P

NONE = 32767            # 위치가 없는 프레임 표시(cm 단위 정수 배열에서)
MIN_TRACK = 13          # 0.5초보다 짧은 기록은 버린다
GROUP_ID0 = 100000      # 사용자가 이은 묶음의 id는 이 수부터 시작


def _player(pid, name, kind, rows, fps, frames, calib, pitch):
    """rows: (frame, x, y, w, h), 프레임 오름차순·중복 없음"""
    fr = rows[:, 0].astype(int); f0 = int(fr[0]); span = int(fr[-1]) - f0 + 1
    box = np.zeros((span, 4), int); box[fr - f0] = np.round(rows[:, 1:5]).astype(int)
    seen = np.zeros(span, bool); seen[fr - f0] = True
    out = dict(id=int(pid), name=name, kind=kind, jersey=-1, team=-1, role=0, f0=f0, n=span, box=box.ravel().tolist(),
               observed_sec=round(len(fr) / fps, 1), segments=[[f0 + s, f0 + e] for s, e in M.runs(seen, 1)], fast_runs=[], jumps=[], titles=[])
    if calib:
        foot = np.column_stack([rows[:, 1] + rows[:, 3] / 2, rows[:, 2] + rows[:, 4]]); pos = P.to_pitch(foot, calib)
        m, Xs, Ys, valid, _ = M.compute(fr, pos[:, 0], pos[:, 1], fps, pitch)
        q = np.column_stack([np.round(Xs * 100), np.round(Ys * 100)]); q[~valid] = NONE
        q = np.clip(q, -NONE, NONE).astype(int)       # 화면 밖으로 멀리 튄 값이 형식을 깨지 않게 한다
        out.update(m, pos=q.ravel().tolist(), segments=[[f0 + s, f0 + e] for s, e in M.runs(seen | valid, 1)])
    return out


def _group_rows(tracks, parts):
    """parts: [{'track': id, 'from': 시작 프레임, 'to': 끝 프레임(포함)}] -> 한 선수의 행. 같은 프레임이 겹치면 앞의 조각을 쓴다."""
    chunks = []
    for part in parts:
        r = tracks[tracks[:, 1] == part['track']]
        r = r[(r[:, 0] >= part.get('from', 0)) & (r[:, 0] <= part.get('to', 10 ** 9))]
        chunks.append(r[:, [0, 2, 3, 4, 5]])
    if not chunks:
        return np.zeros((0, 5))
    rows = np.vstack(chunks); _, first = np.unique(rows[:, 0], return_index=True)     # 프레임 오름차순, 겹치면 먼저 나온 조각
    return rows[first]


def _titles(players):
    cand = [p for p in players if 'distance_m' in p and p['observed_sec'] >= 0.8 * max(q['observed_sec'] for q in players)]
    for key, name in (('distance_m', '최장 이동 거리'), ('top_speed', '최고 속도'), ('hsr_count', '최다 고속 달리기'), ('sprint_count', '최다 스프린트')):
        if len(cand) < 2:
            break
        best = max(cand, key=lambda p: p[key])
        if best[key] > 0 and sum(1 for p in cand if p[key] == best[key]) == 1:
            best['titles'].append(name)


def build(video_id: str, meta: dict, tracks: np.ndarray, calib: dict | None = None, groups: list | None = None) -> dict:
    info = meta['video']; fps = info['fps']; pitch = (meta['pitch']['length'], meta['pitch']['width'])
    players = []
    for i, g in enumerate(groups or []):
        rows = _group_rows(tracks, g.get('parts', []))
        if len(rows):
            players.append(_player(GROUP_ID0 + i, g.get('name') or f'내 선수 {i + 1}', 'player', rows, fps, info['frames'], calib, pitch))
    raw = []
    for tid in np.unique(tracks[:, 1]).astype(int):
        r = tracks[tracks[:, 1] == tid]
        if len(r) >= MIN_TRACK:
            r = r[np.argsort(r[:, 0])]
            raw.append(_player(tid, f'기록 #{tid}', 'track', r[:, [0, 2, 3, 4, 5]], fps, info['frames'], calib, pitch))
    raw.sort(key=lambda p: -p['observed_sec'])
    if calib:
        _titles(players if len(players) > 1 else raw)
    note = '시스템이 자동으로 만든 추적 결과입니다. 번호는 기록 번호이며 한 선수가 여러 기록으로 나뉠 수 있습니다.'
    if calib:
        note += ' 거리와 속도는 아직 검증 전이며 실제보다 크게 나올 수 있습니다.'
    return dict(
        key='track', label='처리 결과', note=note, has_identity=False, has_positions=bool(calib),
        clip=dict(id=video_id, label=meta['name'], fps=fps, frames=info['frames'], width=info['width'], height=info['height'],
                  video=f'/media/{video_id}/video.mp4', t0=info.get('t0', 0)),
        pitch=dict(length=pitch[0], width=pitch[1]), params={k: M.PARAMS[k] for k in ('hsr', 'sprint', 'smooth_sec', 'min_sec', 'max_gap', 'grid')},
        calibration=dict(model=calib.get('model', 'plane'), points=calib['points'], line_points=calib.get('line_points', 0), residual_m=calib['residual_m']) if calib else None,
        players=players + raw,
    )
