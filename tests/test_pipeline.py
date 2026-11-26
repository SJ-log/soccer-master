"""처리 과정의 계산 부분 검사. GPU와 ultralytics 없이 돈다.  실행: python -m pytest -q"""
import numpy as np
import pytest
from server.pipeline import metrics as M, positions as P, package, track as T

FPS = 25


def straight(speed, sec, fps=FPS):
    """x축으로 일정한 속도(m/s)로 달리는 선수"""
    fr = np.arange(int(sec * fps)); return fr, fr / fps * speed, np.zeros(len(fr))


def test_distance_and_speed_of_a_steady_run():
    fr, x, y = straight(4.0, 20)
    m, *_ = M.compute(fr, x, y, FPS)
    assert m['distance_m'] == pytest.approx(4.0 * 20, rel=0.03)
    assert m['top_speed'] == pytest.approx(4.0, abs=0.1)
    assert m['hsr_count'] == 0 and m['sprint_count'] == 0 and m['jumps'] == []


def test_sprint_is_counted_once():
    v = np.concatenate([np.full(100, 2.0), np.full(100, 8.0), np.full(100, 2.0)])       # 4초 동안 8 m/s
    x = np.cumsum(v) / FPS; fr = np.arange(len(x))
    m, *_ = M.compute(fr, x, np.zeros(len(x)), FPS)
    assert m['sprint_count'] == 1 and m['hsr_count'] == 1
    assert m['fast_runs'][0]['sprint'] is True
    assert m['hsr_distance_m'] == pytest.approx(8.0 * 4, rel=0.15)


def test_brief_dip_below_threshold_is_still_one_run():
    # 6 m/s로 2초, 0.4초 동안 5 m/s로 느려졌다가, 다시 6 m/s로 2초: 한 번의 고속 달리기로 센다
    v = np.concatenate([np.full(75, 2.0), np.full(50, 6.0), np.full(10, 5.0), np.full(50, 6.0), np.full(75, 2.0)])
    x = np.cumsum(v) / FPS; fr = np.arange(len(x))
    m, *_ = M.compute(fr, x, np.zeros(len(x)), FPS, params=dict(M.PARAMS, smooth_sec=0.04, pre_median=0))
    assert m['hsr_count'] == 1 and m['fast_runs'][0]['sec'] == pytest.approx(4.4, abs=0.2)
    old, *_ = M.compute(fr, x, np.zeros(len(x)), FPS, params=dict(M.PARAMS, smooth_sec=0.04, pre_median=0, merge_sec=0))
    assert old['hsr_count'] == 2
    # 2초 동안 느려지면 두 번이다
    v2 = np.concatenate([np.full(75, 2.0), np.full(50, 6.0), np.full(50, 4.0), np.full(50, 6.0), np.full(75, 2.0)]); x2 = np.cumsum(v2) / FPS
    m2, *_ = M.compute(np.arange(len(x2)), x2, np.zeros(len(x2)), FPS, params=dict(M.PARAMS, smooth_sec=0.04, pre_median=0))
    assert m2['hsr_count'] == 2


def test_standing_player_with_jitter_does_not_run():
    rng = np.random.default_rng(0); fr = np.arange(750)
    m, *_ = M.compute(fr, rng.normal(0, 0.3, 750), rng.normal(0, 0.3, 750), FPS)
    assert m['distance_m'] < 30           # 떨림만으로 거리가 쌓이는 양(30초에)
    assert m['hsr_count'] == 0


def test_teleport_is_cut_out_not_counted_as_distance():
    fr, x, y = straight(3.0, 20); x = x.copy(); x[250:] += 30          # 10초 시점에 30m 순간 이동(다른 선수로 넘어감)
    m, *_ = M.compute(fr, x, y, FPS)
    assert len(m['jumps']) == 1 and abs(m['jumps'][0] - 250) <= 8
    assert m['distance_m'] < 3.0 * 20 and m['top_speed'] < 4.0


def test_long_gap_is_not_filled():
    fr = np.concatenate([np.arange(0, 100), np.arange(300, 400)]); x = fr / FPS * 3.0
    m, _, _, valid, _ = M.compute(fr, x, np.zeros(len(fr)), FPS)
    assert m['observed_sec'] == pytest.approx(200 / FPS, abs=0.2)
    assert m['distance_m'] == pytest.approx(3.0 * 200 / FPS, rel=0.1)


def test_homography_recovers_pitch_points():
    H = np.array([[0.05, 0.01, -50], [0.002, 0.11, -40], [1e-5, 4e-4, 1]])
    img = np.array([[100, 300], [1800, 320], [1700, 900], [200, 880], [950, 500]], float)
    pts = [dict(img=i.tolist(), pitch=p.tolist()) for i, p in zip(img, P.to_pitch(img, dict(H=H)))]
    c = P.fit(pts)
    assert c['residual_m']['max'] < 0.01
    assert P.to_pitch([[1000, 600]], c) == pytest.approx(P.to_pitch([[1000, 600]], dict(H=H)), abs=0.01)


def _panorama(w=1.3, cy=-0.02, size=(4096, 1080), cam=(0.0, 52.0, 11.0), tilt=0.28, pan=0.05):
    """휘어진 화면(파노라마)을 흉내 낸다: 가까운 쪽 터치라인 뒤 높은 곳의 카메라가 경기장을 내려다보고, 화면의 가로·세로가 각도에 비례한다."""
    f = np.array([np.sin(pan) * np.cos(tilt), -np.cos(pan) * np.cos(tilt), -np.sin(tilt)]); r = np.array([np.cos(pan), np.sin(pan), 0.0]); down = -np.cross(f, r)
    M = np.array([r, down, f]) @ np.array([[1, 0, -cam[0]], [0, 1, -cam[1]], [0, 0, -cam[2]]], float)       # 경기장 (X, Y, 1) -> 카메라가 보는 방향
    return dict(model='lens', H=np.linalg.inv(M).tolist(), lens=dict(w=w, cy=cy, size=list(size)), w_sign=1.0)


def _clicks(true, known, on_line=()):
    pts = [dict(img=i.tolist(), pitch=p.tolist()) for i, p in zip(P.to_image(known, true), np.asarray(known, float))]
    return pts + [dict(img=i.tolist(), line=dict(axis='y', value=float(p[1]))) for i, p in zip(P.to_image(on_line, true), np.asarray(on_line, float))] if len(on_line) else pts


KNOWN13 = [(-52.5, -34), (52.5, -34), (-52.5, 34), (52.5, 34), (0, -34), (0, 34), (0, 0), (0, 9.15), (0, -9.15), (-36, -20.16), (-36, 20.16), (36, -20.16), (36, 20.16)]
CHECK = np.array([(x, y) for x in np.linspace(-50, 50, 9) for y in np.linspace(-30, 30, 7)], float)


def test_lens_fit_beats_plane_on_a_bent_image():
    true = _panorama(); on_line = [(x, y) for y in (-34, 34) for x in np.linspace(-45, 45, 7)]                 # 터치라인 위 14개
    pts = _clicks(true, KNOWN13, on_line)
    assert (P.to_image(KNOWN13, true)[:, 0] > 0).all() and (P.to_image(KNOWN13, true)[:, 0] < 4096).all()       # 찍는 점이 화면 안에 있는 설정인지
    err = lambda c: float(np.hypot(*(P.to_pitch(P.to_image(CHECK, true), c) - CHECK).T).max())
    lens_fit = P.fit(pts, 'lens', (4096, 1080)); plane_fit = P.fit(pts, 'plane', (4096, 1080))
    assert lens_fit['line_points'] == 14 and lens_fit['points'] == 13
    assert err(lens_fit) < 0.05 and err(plane_fit) > 1.0
    assert lens_fit['lens']['w'] == pytest.approx(1.3, abs=0.01) and lens_fit['lens']['cy'] == pytest.approx(-0.02, abs=0.002)


def test_lens_fit_with_nine_points_on_another_camera():
    true = _panorama(w=1.55, cy=0.01, size=(3840, 1504)); pts = _clicks(true, KNOWN13[:9])
    c = P.fit(pts, 'lens', (3840, 1504))
    assert float(np.hypot(*(P.to_pitch(P.to_image(CHECK, true), c) - CHECK).T).max()) < 0.05


def test_lens_fit_is_steady_when_clicks_wobble():
    """찍는 위치가 3px씩 흔들려도 경기장 안의 거리가 거의 그대로여야 한다(11/25 안정화의 기준)."""
    true = _panorama(); rng = np.random.default_rng(0); px = P.to_image(CHECK, true); scale = []
    base = _clicks(true, KNOWN13, [(x, y) for y in (-34, 34) for x in np.linspace(-45, 45, 9)])
    for _ in range(8):
        pts = [dict(p, img=(np.array(p['img']) + rng.normal(0, 3, 2)).tolist()) for p in base]
        q = P.to_pitch(px, P.fit(pts, 'lens', (4096, 1080))); scale.append(np.hypot(*(q[1:] - q[:-1]).T) / np.hypot(*(CHECK[1:] - CHECK[:-1]).T))
    e = np.abs(np.array(scale) - 1)
    assert e.mean() < 0.015 and e.max() < 0.06                # 이웃한 점 사이 거리의 오차: 평균 1.5%, 최대 6% 안


def test_one_bad_click_is_flagged_not_followed():
    true = _panorama(); pts = _clicks(true, KNOWN13, [(x, y) for y in (-34, 34) for x in np.linspace(-45, 45, 9)])
    pts[9] = dict(pts[9], img=[pts[9]['img'][0] + 60, pts[9]['img'][1] + 25])                                    # 한 점을 크게 잘못 찍음
    c = P.fit(pts, 'lens', (4096, 1080)); e = c['point_errors_m']
    assert e[9] == max(e) and e[9] > 2.0                                                                         # 그 점이 가장 크게 어긋난 점으로 드러난다
    assert float(np.median(np.hypot(*(P.to_pitch(P.to_image(CHECK, true), c) - CHECK).T))) < 0.3                 # 나머지는 거의 그대로


def test_to_image_is_the_inverse_of_to_pitch():
    true = _panorama(); pts = _clicks(true, KNOWN13)
    check = np.array([(x, y) for x in np.linspace(-50, 50, 5) for y in np.linspace(-30, 30, 4)], float)
    for model in ('lens', 'plane'):
        c = P.fit(pts, model, (4096, 1080))
        assert P.to_pitch(P.to_image(check, c), c) == pytest.approx(check, abs=0.05)
        assert len(c['point_errors_m']) == len(pts)


def test_old_lens_result_is_not_current():
    assert not P.is_current(dict(model='lens', H=np.eye(3).tolist(), lens=[1600.0, 2400.0, 2000.0, 520.0, -0.07, 0.02]))
    assert P.is_current(dict(model='plane', H=np.eye(3).tolist(), lens=None)) and P.is_current(_panorama())


def test_pitch_landmarks_and_shapes():
    from server.pipeline import pitch
    lm = pitch.landmarks(105, 68); ids = [p['id'] for p in lm]
    assert len(ids) == len(set(ids)) == 35
    by = {p['id']: p['pitch'] for p in lm}
    assert by['cornerLF'] == [-52.5, -34] and by['penInRN'] == [36.0, 20.16] and by['center'] == [0, 0] and by['spotL'] == [-41.5, 0]
    assert all(abs(x) <= 52.5 and abs(y) <= 34 for x, y in by.values())
    sh = pitch.shapes(105, 68)
    assert len(sh) == 12 and all(abs(x) <= 52.51 and abs(y) <= 34.01 for line in sh for x, y in line)
    assert {l['id'] for l in pitch.lines(105, 68)} == {'touchF', 'touchN', 'goalL', 'goalR', 'halfway'}


def test_lens_needs_nine_points_and_bad_line_is_rejected():
    pts = [dict(img=[i * 100, i * 37 % 500], pitch=[i, i * i % 7]) for i in range(8)]
    with pytest.raises(ValueError):
        P.fit(pts, 'lens')
    with pytest.raises(ValueError):
        P.fit([dict(img=[i * 100, i * 37 % 500], pitch=[i, i]) for i in range(12)], 'lens')     # 경기장에서 한 줄로 늘어선 점
    with pytest.raises(ValueError):
        P.fit(pts + [dict(img=[1, 2], line=dict(axis='z', value=0))], 'plane')


def test_calibration_needs_four_points():
    with pytest.raises(ValueError):
        P.fit([dict(img=[0, 0], pitch=[0, 0])] * 3)


def _tracks():
    """기록 1: 0~99프레임, 기록 2: 110~209프레임(같은 선수가 이어서 달림), 기록 3: 멀리 떨어진 다른 선수"""
    rows = []
    for f in range(100):
        rows.append((f, 1, 100 + f * 2, 400, 20, 60))
    for f in range(110, 210):
        rows.append((f, 2, 100 + f * 2, 400, 20, 60))
    for f in range(0, 210):
        rows.append((f, 3, 1500, 700, 20, 60))
    return np.array(rows, float)


def test_stitch_joins_a_broken_track_and_interpolate_fills_it():
    t = T.interpolate(T.stitch(_tracks()))
    assert len(np.unique(t[:, 1])) == 2
    joined = t[t[:, 1] == 1]
    assert len(joined) == 210 and joined[105, 2] == pytest.approx(100 + 105 * 2, abs=1)


META = dict(name='t', kind='panorama', pitch=dict(length=105, width=68), video=dict(fps=25, frames=210, width=1920, height=1080, t0=0))


def test_package_without_calibration_has_boxes_only():
    d = package.build('abc12345', META, _tracks())
    assert d['has_positions'] is False and len(d['players']) == 3
    p = d['players'][0]
    assert 'pos' not in p and 'distance_m' not in p and len(p['box']) == p['n'] * 4


def test_package_with_calibration_and_user_groups():
    calib = P.fit([dict(img=i, pitch=p) for i, p in [([0, 0], [-52.5, -34]), ([1920, 0], [52.5, -34]), ([1920, 1080], [52.5, 34]), ([0, 1080], [-52.5, 34])]])
    groups = [dict(name='나', parts=[dict(track=1), dict(track=2, **{'from': 110, 'to': 150})])]
    d = package.build('abc12345', META, _tracks(), calib, groups)
    me = d['players'][0]
    assert d['has_positions'] and me['kind'] == 'player' and me['name'] == '나'
    assert me['f0'] == 0 and me['n'] == 151 and len(me['pos']) == me['n'] * 2
    assert me['segments'] == [[0, 151]]          # 10프레임 빈 구간은 채워진다
    assert me['distance_m'] > 0 and [p['kind'] for p in d['players'][1:]] == ['track'] * 3
