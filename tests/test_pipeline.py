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


def test_lens_fit_beats_plane_on_a_bent_image():
    """휘어진 화면(파노라마)을 흉내 낸다: 경기장 점을 평면 변환 후 어안 렌즈로 화면에 옮긴다."""
    import cv2
    lens = [1600.0, 2400.0, 2000.0, 520.0, -0.07, 0.02]; K = np.array([[lens[0], 0, lens[2]], [0, lens[1], lens[3]], [0, 0, 1.0]]); D = np.array(lens[4:] + [0, 0]).reshape(4, 1)
    def to_img(pitch):       # 경기장 -> 화면
        n = np.column_stack([pitch[:, 0] / 60.0, (pitch[:, 1] + 70) / 110.0 - 0.6]); return cv2.fisheye.distortPoints(n.reshape(-1, 1, 2), K, D).reshape(-1, 2)
    xs = [-52.5, -36, 0, 36, 52.5]; ys = [-34, -20.16, 0, 20.16, 34]
    known = np.array([(x, y) for x in xs for y in ys if (x, y) not in ((-36, 0), (36, 0))], float)            # 선이 만나는 곳 23개
    on_line = np.array([(x, y) for y in (-34, 34) for x in np.linspace(-45, 45, 7)], float)                    # 터치라인 위 14개
    pts = [dict(img=i.tolist(), pitch=p.tolist()) for i, p in zip(to_img(known), known)]
    pts += [dict(img=i.tolist(), line=dict(axis='y', value=float(p[1]))) for i, p in zip(to_img(on_line), on_line)]
    check = np.array([(x, y) for x in np.linspace(-50, 50, 9) for y in np.linspace(-30, 30, 7)], float)
    err = lambda c: float(np.hypot(*(P.to_pitch(to_img(check), c) - check).T).max())
    lens_fit = P.fit(pts, 'lens', (4096, 1080)); plane_fit = P.fit(pts, 'plane')
    assert lens_fit['line_points'] == 14 and lens_fit['points'] == 23
    assert err(lens_fit) < 0.3 < err(plane_fit)


def test_to_image_is_the_inverse_of_to_pitch():
    import cv2
    lens = [1600.0, 2400.0, 2000.0, 520.0, -0.07, 0.02]; K = np.array([[lens[0], 0, lens[2]], [0, lens[1], lens[3]], [0, 0, 1.0]]); D = np.array(lens[4:] + [0, 0]).reshape(4, 1)
    to_img = lambda pitch: cv2.fisheye.distortPoints(np.column_stack([pitch[:, 0] / 60.0, (pitch[:, 1] + 70) / 110.0 - 0.6]).reshape(-1, 1, 2), K, D).reshape(-1, 2)
    known = np.array([(x, y) for x in (-52.5, -36, 0, 36, 52.5) for y in (-34, -20.16, 0, 20.16, 34)], float)
    pts = [dict(img=i.tolist(), pitch=p.tolist()) for i, p in zip(to_img(known), known)]
    check = np.array([(x, y) for x in np.linspace(-50, 50, 5) for y in np.linspace(-30, 30, 4)], float)
    for model in ('lens', 'plane'):
        c = P.fit(pts, model, (4096, 1080))
        assert P.to_pitch(P.to_image(check, c), c) == pytest.approx(check, abs=0.05)
        assert len(c['point_errors_m']) == len(pts)


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
    pts = [dict(img=[i * 100, i * 37 % 500], pitch=[i, i]) for i in range(8)]
    with pytest.raises(ValueError):
        P.fit(pts, 'lens')
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
