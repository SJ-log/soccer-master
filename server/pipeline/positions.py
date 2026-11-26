"""화면 좌표 -> 경기장 좌표(m). 사용자가 찍은 점으로 변환을 맞춘다.

경기장 좌표의 원점은 경기장 중앙이고, x는 길이 방향, y는 폭 방향이다.

두 가지 방식이 있다.
- plane: 평면 변환(호모그래피) 하나. 화면이 휘지 않은 영상용. 점 4개 이상.
- lens:  파노라마용. 화면의 가로 위치는 좌우 각도에, 세로 위치는 위아래 각도에 비례한다고 보고(등장방형 파노라마),
         각도의 축척 w와 수평선 높이 cy 두 값을 평면 변환과 함께 맞춘다. 점 9개 이상.

lens를 이렇게 정한 이유(11/25 실험, SoccerTrack v2 검증 클립 2개, 근거: 캡스톤 폴더 03_학습실험/calib_20261125/결과.md)
- 처음에는 어안 렌즈 값 6개(fx, fy, cx, cy, k1, k2)를 맞췄다. 초점 거리와 휨 값이 서로를 메워 주어서 찍은 점에서는 똑같이 맞는 답이 여러 개였고,
  찍는 위치가 3px만 흔들려도(13점 + 선 위 18점) 같은 선수의 이동 거리가 ±2.6~3.2%, 고속 달리기 횟수가 38~93회(128057)로 달라졌다.
- 두 클립 모두 실제로는 가로가 각도에 비례하는 파노라마였다. 값 2개짜리 이 모델은 같은 조건에서 ±0.5~0.6%, 48~56회다.
- 오차는 경기장 m가 아니라 화면 px로 잰다. 먼 쪽은 1px이 0.25m, 가까운 쪽은 0.05m라서 m로 재면 먼 쪽 점의 흔들림이 결과를 좌우한다.
- 평면 변환도 렌즈 값과 함께 맞춘다(선 위의 점도 평면 변환을 정하는 데 쓰인다). OpenCV에 기대지 않는다.
- 점 6개로도 계산은 되지만 132831에서 ±8.5%까지 흔들려서 최소는 9개로 둔다(9개부터는 두 클립 모두 ±1% 안, 3px 흔들림 기준).

점의 형식
- 위치를 아는 점:  {"img": [x, y], "pitch": [X, Y]}             (선이 만나는 곳)
- 선 위의 점:      {"img": [x, y], "line": {"axis": "y", "value": -34}}   (어느 선 위인지만 아는 점. 예: 터치라인 위 아무 곳)
"""
import numpy as np
from scipy.optimize import least_squares

MIN_POINTS = dict(plane=4, lens=9)
F_SCALE_PX = 4.0             # 이보다 크게 어긋난 점은 덜 믿는다(잘못 찍은 점 하나가 전체를 끌고 가지 않게)
W_START = (0.5, 1.0, 1.5)    # 각도 축척의 시작값(화면 절반 폭이 몇 rad인가). 가장 잘 맞는 것을 고른다
W_RANGE, CY_RANGE = (0.05, 2.6), (-0.5, 0.5)


def _dirs(p, lens):
    """화면 px -> 평면 변환을 적용할 3차원 벡터. plane은 (x, y, 1), lens는 그 화소가 바라보는 방향."""
    p = np.asarray(p, np.float64).reshape(-1, 2)
    if lens is None:
        return np.column_stack([p, np.ones(len(p))])
    W, H = lens['size']; s = W / 2.0; w = lens['w']
    az = w * (p[:, 0] - W / 2) / s; el = w * ((p[:, 1] - H / 2) / s - lens['cy'])
    return np.column_stack([np.sin(az) * np.cos(el), np.sin(el), np.cos(az) * np.cos(el)])


def _apply(H, d):
    v = d @ np.asarray(H, np.float64).T; z = v[:, 2:3]
    return v[:, :2] / np.where(np.abs(z) < 1e-12, 1e-12, z)


def _dlt(d, pitch):
    """벡터 d(n,3) -> 경기장 좌표(n,2)의 평면 변환을 직접 푼다. 위치를 아는 점이 화면의 앞쪽(z > 0)에 오도록 부호를 맞춘다."""
    c = pitch.mean(0); s = np.sqrt(2) / max(float(np.mean(np.hypot(*(pitch - c).T))), 1e-12)
    T = np.array([[s, 0, -s * c[0]], [0, s, -s * c[1]], [0, 0, 1.0]]); b = (pitch - c) * s; A = []
    for u, (X, Y) in zip(d, b):
        A.append(np.concatenate([-u, np.zeros(3), X * u])); A.append(np.concatenate([np.zeros(3), -u, Y * u]))
    sv = np.linalg.svd(np.asarray(A))
    if sv[1][-2] < 1e-9 * sv[1][0]:
        raise ValueError('점의 배치로는 변환을 구할 수 없습니다 (한 줄로 늘어서 있지 않은지 확인)')
    H = np.linalg.inv(T) @ sv[2][-1].reshape(3, 3)
    return H if np.median(d @ H[2]) > 0 else -H


def _on_one_line(p):
    s = np.linalg.svd(p - p.mean(0), compute_uv=False)
    return s[1] < 1e-3 * max(s[0], 1e-12)


def _split(points):
    known = [p for p in points if 'pitch' in p]; on_line = [p for p in points if 'line' in p and 'pitch' not in p]
    for p in on_line:
        if p['line'].get('axis') not in ('x', 'y') or not isinstance(p['line'].get('value'), (int, float)):
            raise ValueError('선 위의 점에는 axis(x 또는 y)와 value가 필요합니다')
    return (np.array([p['img'] for p in known], np.float64).reshape(-1, 2), np.array([p['pitch'] for p in known], np.float64).reshape(-1, 2),
            np.array([p['img'] for p in on_line], np.float64).reshape(-1, 2), np.array([0 if p['line']['axis'] == 'x' else 1 for p in on_line], int),
            np.array([p['line']['value'] for p in on_line], np.float64))


def fit(points: list[dict], model: str = 'plane', size: tuple[int, int] = (1920, 1080)) -> dict:
    """반환: {model, H, lens, w_sign, residual_m: {mean, max}, point_errors_m, points, line_points}. residual_m은 찍은 점에서의 오차다."""
    if model not in MIN_POINTS:
        raise ValueError('model은 plane 또는 lens입니다')
    img, pitch, limg, axis, value = _split(points)
    if len(img) < MIN_POINTS[model]:
        raise ValueError(f'위치를 아는 점이 {MIN_POINTS[model]}개 이상 필요합니다 (지금 {len(img)}개)')
    if _on_one_line(img) or _on_one_line(pitch):
        raise ValueError('점의 배치로는 변환을 구할 수 없습니다 (한 줄로 늘어서 있지 않은지 확인)')
    size = (float(size[0]), float(size[1])); allp = np.vstack([img, limg]); n = len(img); k = np.arange(len(limg))
    # 계산은 화면 중앙을 원점으로, 화면 절반 폭을 1로 둔 좌표에서 한다(평면 변환의 값 크기가 고르게 된다)
    N = np.array([[2 / size[0], 0, -1.0], [0, 2 / size[0], -size[1] / size[0]], [0, 0, 1.0]])
    lens_of = (lambda th: dict(w=float(th[0]), cy=float(th[1]), size=list(size))) if model == 'lens' else (lambda th: None)
    vec = lambda p, th: _dirs(p, lens_of(th)) if model == 'lens' else _dirs(p, None) @ N.T

    def residual(th, H):
        """찍은 점이 화면에서 몇 px 어긋나는가(1차 근사). 위치를 아는 점은 J^-1 (F - P), 선 위의 점은 그 선까지의 거리."""
        F = lambda p: _apply(H, vec(p, th)); e = 0.5
        f0 = F(allp); fx = (F(allp + [e, 0]) - F(allp - [e, 0])) / (2 * e); fy = (F(allp + [0, e]) - F(allp - [0, e])) / (2 * e)
        d = f0[:n] - pitch; a, b, c, dd = fx[:n, 0], fy[:n, 0], fx[:n, 1], fy[:n, 1]; det = a * dd - b * c; det = np.where(np.abs(det) < 1e-12, 1e-12, det)
        r = np.column_stack([(dd * d[:, 0] - b * d[:, 1]) / det, (-c * d[:, 0] + a * d[:, 1]) / det]).ravel()
        if len(limg):
            r = np.concatenate([r, (f0[n:][k, axis] - value) / np.maximum(np.hypot(fx[n:][k, axis], fy[n:][k, axis]), 1e-9)])
        return np.where(np.isfinite(r), r, 1e3)

    def solve(th0):
        nth = len(th0); lo, hi = ([W_RANGE[0], CY_RANGE[0]], [W_RANGE[1], CY_RANGE[1]]) if nth else ([], [])
        if nth:       # 1단계: 렌즈 값만(평면 변환은 직접 풀어서) 대강 맞춘다
            th0 = least_squares(lambda th: residual(th, _dlt(vec(img, th), pitch)), th0, bounds=(lo, hi), loss='soft_l1', f_scale=F_SCALE_PX, max_nfev=200).x
        H0 = _dlt(vec(img, th0), pitch); piv = int(np.argmax(np.abs(H0))); H0 = H0 / H0.flat[piv]; rest = [i for i in range(9) if i != piv]
        def unpack(x):
            h = np.empty(9); h[piv] = 1.0; h[rest] = x[nth:]; return x[:nth], h.reshape(3, 3)
        # 2단계: 렌즈 값과 평면 변환을 함께 맞춘다
        r = least_squares(lambda x: residual(*unpack(x)), np.concatenate([th0, H0.ravel()[rest]]), bounds=(lo + [-np.inf] * 8, hi + [np.inf] * 8),
                          loss='soft_l1', f_scale=F_SCALE_PX, x_scale='jac', max_nfev=2000)
        th, H = unpack(r.x)
        return r.cost, th, (H if np.median(vec(img, th) @ H[2]) > 0 else -H)

    best = None
    for th0 in ([np.array([w, 0.0]) for w in W_START] if model == 'lens' else [np.zeros(0)]):
        try:
            cand = solve(th0)
        except (np.linalg.LinAlgError, FloatingPointError):
            continue
        if best is None or cand[0] < best[0]:
            best = cand
    if best is None or not np.isfinite(best[2]).all():
        raise ValueError('점의 배치로는 변환을 구할 수 없습니다 (한 줄로 늘어서 있지 않은지 확인)')
    _, th, H = best; lens = lens_of(th)
    if model == 'plane':
        H = H @ N                                          # 저장하는 H는 화면 px에 바로 적용한다
    calib = dict(model=model, H=H.tolist(), lens=lens, w_sign=1.0)
    res = np.hypot(*(to_pitch(img, calib) - pitch).T); lres = np.abs(to_pitch(limg, calib)[k, axis] - value) if len(limg) else np.zeros(0)
    # 점마다의 오차를 넣은 순서대로 돌려준다(어느 점을 잘못 찍었는지 보이게)
    it, il = iter(res.tolist()), iter(lres.tolist()); errors = [round(next(it) if 'pitch' in p else next(il), 2) for p in points if 'pitch' in p or 'line' in p]
    allres = np.concatenate([res, lres])
    calib.update(residual_m=dict(mean=round(float(allres.mean()), 2), max=round(float(allres.max()), 2)), point_errors_m=errors, points=len(img), line_points=len(limg))
    return calib


def is_current(calib) -> bool:
    """11/25 전에 저장한 lens 결과(어안 렌즈 값 6개의 목록)는 지금 형식이 아니다. 찍은 점(points_raw)으로 다시 맞춰야 한다."""
    return calib.get('lens') is None or isinstance(calib.get('lens'), dict)


def to_image(pitch, calib) -> np.ndarray:
    """경기장 m -> 화면 px (to_pitch의 반대). 맞춘 결과로 경기장 선을 영상 위에 다시 그릴 때 쓴다.
    카메라 뒤쪽으로 넘어가 화면에 나올 수 없는 점은 NaN."""
    p = np.asarray(pitch, np.float64).reshape(-1, 2); Hinv = np.linalg.inv(np.asarray(calib['H'], np.float64))
    v = np.column_stack([p, np.ones(len(p))]) @ Hinv.T * calib.get('w_sign', 1.0); u = np.full((len(p), 2), np.nan)
    lens = calib.get('lens')
    if lens is None:
        ok = v[:, 2] > 1e-9; u[ok] = v[ok, :2] / v[ok, 2:3]; return u
    W, H = lens['size']; s = W / 2.0; d = v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-12)
    az = np.arctan2(d[:, 0], d[:, 2]); el = np.arcsin(np.clip(d[:, 1], -1, 1)); ok = np.abs(az) < 0.97 * np.pi      # 바로 뒤쪽은 화면의 양 끝으로 갈라지므로 뺀다
    u[ok] = np.column_stack([W / 2 + s * az[ok] / lens['w'], H / 2 + s * (el[ok] / lens['w'] + lens['cy'])])
    return u


def to_pitch(foot, calib) -> np.ndarray:
    """foot: (n, 2) 화면 px -> (n, 2) 경기장 m. calib: fit()의 반환값"""
    return _apply(calib['H'], _dirs(foot, calib.get('lens')))
