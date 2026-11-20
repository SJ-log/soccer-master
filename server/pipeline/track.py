"""추적: 저장된 검출 결과로 BoT-SORT를 돌리고, 끊긴 기록을 잇고, 짧은 빈 구간을 채운다.

설정은 11/19~20에 SoccerTrack v2 학습 클립 6개에서 고른 값(c2)이다.
카메라가 고정이라는 전제로 카메라 움직임 보정은 끈다.
"""
from types import SimpleNamespace
import numpy as np
from scipy.optimize import linear_sum_assignment

BOTSORT = dict(tracker_type='botsort', track_high_thresh=0.6, track_low_thresh=0.1, new_track_thresh=0.8, track_buffer=75, match_thresh=0.9,
               fuse_score=True, gmc_method='none', proximity_thresh=0.5, appearance_thresh=0.8, with_reid=False, model='auto')
STITCH = dict(gap=125, a=1.0, b=0.3)     # 5초 안, 박스 높이의 (1.0 + 0.3×간격)배 거리 안이면 같은 선수로 잇는다
INTERP = 15                              # 15프레임 이하 빈 구간은 직선으로 채운다


def run_tracker(det: np.ndarray, width: int, height: int, frames: int, on_progress=lambda done, total: None) -> np.ndarray:
    """det: (frame, x1, y1, x2, y2, conf) -> (frame, id, x, y, w, h)"""
    from ultralytics.trackers.bot_sort import BOTSORT as Tracker
    from ultralytics.engine.results import Boxes
    det = det[det[:, 5] >= BOTSORT['track_low_thresh']]
    start = np.searchsorted(det[:, 0], np.arange(frames + 1))
    tracker = Tracker(SimpleNamespace(**BOTSORT)); dummy = np.zeros((4, 4, 3), np.uint8); rows = []
    for f in range(frames):
        d = det[start[f]:start[f + 1]]
        out = tracker.update(Boxes(np.column_stack([d[:, 1:6], np.zeros(len(d))]).astype(np.float32), (height, width)), dummy)
        for o in out:
            x1, y1, x2, y2 = d[int(o[-1]), 1:5]
            rows.append((f, int(o[4]), x1, y1, x2 - x1, y2 - y1))
        if f % 500 == 0:
            on_progress(f, frames)
    return np.array(rows, dtype=np.float64).reshape(-1, 6)


def stitch(tracks: np.ndarray, gap=STITCH['gap'], a=STITCH['a'], b=STITCH['b']) -> np.ndarray:
    """한 기록이 끝난 뒤 gap 프레임 안에, 박스 높이의 (a + b×간격)배 거리 안에서 시작하는 기록을 같은 id로 잇는다."""
    ids = np.unique(tracks[:, 1])
    if len(ids) < 2:
        return tracks
    ends, starts = [], []
    for i in ids:
        r = tracks[tracks[:, 1] == i]; r = r[np.argsort(r[:, 0])]
        starts.append((r[0, 0], r[0, 2] + r[0, 4] / 2, r[0, 3] + r[0, 5]))
        ends.append((r[-1, 0], r[-1, 2] + r[-1, 4] / 2, r[-1, 3] + r[-1, 5], np.median(r[:, 5])))
    ends, starts = np.array(ends), np.array(starts)
    dt = starts[None, :, 0] - ends[:, None, 0]
    dist = np.hypot(starts[None, :, 1] - ends[:, None, 1], starts[None, :, 2] - ends[:, None, 2])
    ok = (dt >= 1) & (dt <= gap) & (dist <= ends[:, None, 3] * (a + b * dt))
    rr, cc = linear_sum_assignment(np.where(ok, dist + dt, 1e6))
    parent = {i: i for i in ids}

    def find(x):
        while parent[x] != x:
            x = parent[x]
        return x
    for r_, c_ in zip(rr, cc):
        if ok[r_, c_]:
            parent[ids[c_]] = find(ids[r_])
    out = tracks.copy(); out[:, 1] = [find(i) for i in tracks[:, 1]]
    return out


def interpolate(tracks: np.ndarray, max_gap=INTERP) -> np.ndarray:
    """한 기록 안의 짧은 빈 구간(max_gap 프레임 이하)을 직선으로 채운다."""
    add = []
    for i in np.unique(tracks[:, 1]):
        r = tracks[tracks[:, 1] == i]; r = r[np.argsort(r[:, 0])]
        for k in np.nonzero(np.diff(r[:, 0]) > 1)[0]:
            g = int(r[k + 1, 0] - r[k, 0])
            if g - 1 <= max_gap:
                for j in range(1, g):
                    add.append(r[k] + (r[k + 1] - r[k]) * j / g)
    if add:
        add = np.array(add); add[:, 0] = np.round(add[:, 0]); add[:, 1] = np.round(add[:, 1]); tracks = np.vstack([tracks, add])
    return tracks[np.lexsort((tracks[:, 1], tracks[:, 0]))]


def track(det, width, height, frames, on_progress=lambda done, total: None) -> np.ndarray:
    return interpolate(stitch(run_tracker(det, width, height, frames, on_progress)))
