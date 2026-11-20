"""화면 좌표 -> 경기장 좌표(m). 사용자가 찍은 점으로 변환을 맞춘다.

경기장 좌표의 원점은 경기장 중앙이고, x는 길이 방향, y는 폭 방향이다.

두 가지 방식이 있다.
- plane: 평면 변환(호모그래피) 하나. 화면이 휘지 않은 영상용. 점 4개 이상.
- lens:  렌즈 휨(fx, fy, cx, cy, k1, k2)을 함께 맞춘 뒤 평면 변환. 화면이 휜 파노라마용. 점 9개 이상.
  파노라마에서 plane을 쓰면 거리 오차가 15~22%이고 고속 달리기 횟수가 3~4배로 나온다(11/20 SoccerTrack v2 검증 클립 2개).
  lens는 위치를 아는 점 13개 이상 + 선 위의 점 9개 이상일 때 거리 오차 2~4%였다. 다만 찍는 위치가 3~6px 흔들리면 결과가 크게 달라질 수 있다.

점의 형식
- 위치를 아는 점:  {"img": [x, y], "pitch": [X, Y]}             (선이 만나는 곳)
- 선 위의 점:      {"img": [x, y], "line": {"axis": "y", "value": -34}}   (어느 선 위인지만 아는 점. 예: 터치라인 위 아무 곳)
"""
import numpy as np
import cv2
from scipy.optimize import least_squares

MIN_POINTS = dict(plane=4, lens=9)


def _homography(img, pitch):
    H, _ = cv2.findHomography(np.asarray(img, np.float64), np.asarray(pitch, np.float64), 0)
    if H is None:
        raise ValueError('점의 배치로는 변환을 구할 수 없습니다 (한 줄로 늘어서 있지 않은지 확인)')
    return H


def _undistort(p, lens):
    if lens is None:
        return np.asarray(p, np.float64).reshape(-1, 2)
    K = np.array([[lens[0], 0, lens[2]], [0, lens[1], lens[3]], [0, 0, 1.0]])
    return cv2.fisheye.undistortPoints(np.asarray(p, np.float64).reshape(-1, 1, 2), K, np.array([lens[4], lens[5], 0, 0]).reshape(4, 1), P=K).reshape(-1, 2)


def _project(p, H, lens):
    return cv2.perspectiveTransform(_undistort(p, lens).reshape(-1, 1, 2), np.asarray(H, np.float64)).reshape(-1, 2)


def _split(points):
    known = [p for p in points if 'pitch' in p]; on_line = [p for p in points if 'line' in p and 'pitch' not in p]
    for p in on_line:
        if p['line'].get('axis') not in ('x', 'y') or not isinstance(p['line'].get('value'), (int, float)):
            raise ValueError('선 위의 점에는 axis(x 또는 y)와 value가 필요합니다')
    return (np.array([p['img'] for p in known], np.float64).reshape(-1, 2), np.array([p['pitch'] for p in known], np.float64).reshape(-1, 2),
            np.array([p['img'] for p in on_line], np.float64).reshape(-1, 2), np.array([0 if p['line']['axis'] == 'x' else 1 for p in on_line], int),
            np.array([p['line']['value'] for p in on_line], np.float64))


def fit(points: list[dict], model: str = 'plane', size: tuple[int, int] = (1920, 1080)) -> dict:
    """반환: {model, H, lens, residual_m: {mean, max}, points, line_points}. residual_m은 찍은 점에서의 오차다."""
    if model not in MIN_POINTS:
        raise ValueError('model은 plane 또는 lens입니다')
    img, pitch, limg, axis, value = _split(points)
    if len(img) < MIN_POINTS[model]:
        raise ValueError(f'위치를 아는 점이 {MIN_POINTS[model]}개 이상 필요합니다 (지금 {len(img)}개)')
    lens = None
    if model == 'lens':
        def residual(x):
            try:
                H = _homography(_undistort(img, x), pitch); r = (_project(img, H, x) - pitch).ravel()
                if len(limg):
                    r = np.concatenate([r, _project(limg, H, x)[np.arange(len(limg)), axis] - value])
                return r
            except (ValueError, cv2.error):
                return np.full(len(img) * 2 + len(limg), 1e3)
        best = None
        for f in (0.25, 0.5, 1.0):         # 초점 거리의 시작값을 바꿔 가며 가장 잘 맞는 것을 고른다
            r = least_squares(residual, [size[0] * f, size[0] * f, size[0] / 2, size[1] / 2, 0, 0], x_scale=[1000, 1000, 1000, 500, 0.1, 0.1], loss='soft_l1', max_nfev=600)
            if best is None or r.cost < best.cost:
                best = r
        lens = [float(v) for v in best.x]
    H = _homography(_undistort(img, lens), pitch)
    res = np.hypot(*(_project(img, H, lens) - pitch).T)
    if len(limg):
        res = np.concatenate([res, np.abs(_project(limg, H, lens)[np.arange(len(limg)), axis] - value)])
    return dict(model=model, H=H.tolist(), lens=lens, residual_m=dict(mean=round(float(res.mean()), 2), max=round(float(res.max()), 2)), points=len(img), line_points=len(limg))


def to_pitch(foot, calib) -> np.ndarray:
    """foot: (n, 2) 화면 px -> (n, 2) 경기장 m. calib: fit()의 반환값"""
    return _project(foot, calib['H'], calib.get('lens'))
