"""프레임별 경기장 위치(m) -> 움직임 지표. 프로토타입_v2/tools/build_data.py와 같은 계산이다."""
import numpy as np

PARAMS = dict(
    smooth_sec=1.0,   # 위치 1초 이동평균
    hsr=5.5,          # 고속 달리기 기준 m/s
    sprint=7.0,       # 스프린트 기준 m/s
    min_sec=1.0,      # 한 번의 달리기는 이 시간 이상 이어져야 센다
    merge_sec=0.5,    # 기준 속도 아래로 내려갔다가 이 시간 안에 다시 넘으면 같은 달리기로 본다(11/21: 이 규칙이 없으면 횟수가 기준보다 50% 많게 나옴)
    max_gap=25,       # 이 프레임 수 이하의 빈 구간만 직선으로 채운다
    grid=(6, 4),      # 활동 구역 칸 수
    pre_median=13,    # 추적 결과의 떨림을 누르는 중앙값 창(프레임). 0이면 쓰지 않음
    jump_m=8.0,       # 3프레임 사이에 이만큼 움직이면 순간 이동(다른 선수로 넘어감)으로 보고 앞뒤를 뺀다
)


def _smooth(a, k):
    k = int(k) | 1
    return np.convolve(np.pad(a, (k // 2, k // 2), mode='edge'), np.ones(k) / k, 'valid')


def _median(a, k):
    k = int(k) | 1
    return np.median(np.lib.stride_tricks.sliding_window_view(np.pad(a, k // 2, mode='edge'), k), axis=1)


def runs(mask, min_len):
    d = np.diff(np.concatenate([[0], np.asarray(mask).astype(int), [0]])); s, e = np.nonzero(d == 1)[0], np.nonzero(d == -1)[0]
    keep = (e - s) >= min_len
    return list(zip(s[keep].tolist(), e[keep].tolist()))


def bursts(v, threshold, merge, min_len):
    """기준 속도 이상으로 달린 구간들. 잠깐(merge 프레임 이하) 느려진 틈은 메워서 한 번으로 센다."""
    fast = np.asarray(v) >= threshold
    for s, e in runs(~fast, 1):
        if s > 0 and e < len(fast) and e - s <= merge:
            fast[s:e] = True
    return runs(fast, min_len)


def compute(fr, x, y, fps, pitch=(105.0, 68.0), params=PARAMS):
    """fr: 오름차순 프레임 번호, x·y: 경기장 좌표(m). 반환: (지표 dict, 다듬은 x, 다듬은 y, 유효 여부, 시작 프레임)"""
    p = params; fps_i = int(round(fps)); fr = np.asarray(fr).astype(int)
    f0, f1 = int(fr[0]), int(fr[-1]); full = np.arange(f0, f1 + 1)
    X = np.interp(full, fr, x); Y = np.interp(full, fr, y)
    valid = np.ones(len(full), bool)
    for i in np.nonzero(np.diff(fr) > p['max_gap'])[0]:
        valid[fr[i] - f0 + 1: fr[i + 1] - f0] = False
    if p['pre_median'] and len(full) > p['pre_median']:
        X, Y = _median(X, p['pre_median']), _median(Y, p['pre_median'])
    jumps = np.array([], dtype=int)
    if len(full) > 8:
        Xm, Ym = _median(X, 5), _median(Y, 5)
        far = (np.hypot(Xm[3:] - Xm[:-3], Ym[3:] - Ym[:-3]) > p['jump_m']) & valid[3:] & valid[:-3]
        jumps = np.array([s for s, _ in runs(far, 1)], dtype=int); half = (int(p['smooth_sec'] * fps_i) | 1) // 2
        for i in jumps:
            valid[max(0, i - half): i + 4 + half] = False
    Xs, Ys = _smooth(X, p['smooth_sec'] * fps_i), _smooth(Y, p['smooth_sec'] * fps_i)
    step = np.hypot(np.diff(Xs), np.diff(Ys)); ok = valid[1:] & valid[:-1]; step = np.where(ok, step, 0.0); v = step * fps
    obs = valid.sum() / fps
    hist, _, _ = np.histogram2d(Xs[valid], Ys[valid], bins=p['grid'], range=[[-pitch[0] / 2, pitch[0] / 2], [-pitch[1] / 2, pitch[1] / 2]])
    min_len = max(1, int(p['min_sec'] * fps_i)); merge = int(p.get('merge_sec', 0) * fps_i); hs = bursts(v, p['hsr'], merge, min_len); sp = bursts(v, p['sprint'], merge, min_len)
    speed_1hz = [round(float(v[s:s + fps_i][ok[s:s + fps_i]].mean()), 2) if ok[s:s + fps_i].any() else None for s in range(0, len(v), fps_i)]
    m = dict(
        observed_sec=round(float(obs), 1), distance_m=round(float(step.sum()), 1), avg_speed=round(float(step.sum() / max(obs, 1e-9)), 2),
        top_speed=round(float(np.percentile(v[ok], 99.5)), 2) if ok.any() else 0.0,
        hsr_distance_m=round(float(sum(step[s:e].sum() for s, e in hs)), 1), hsr_count=len(hs), sprint_count=len(sp),
        zone_share=(hist / max(hist.sum(), 1)).round(3).T.tolist(), speed_1hz=speed_1hz, speed_f0=f0, jumps=[int(f0 + i) for i in jumps],
        fast_runs=[dict(start=f0 + s, end=f0 + e, distance_m=round(float(step[s:e].sum()), 1), sec=round((e - s) / fps, 1),
                        avg=round(float(step[s:e].sum() / ((e - s) / fps)), 2), sprint=any(a < e and b > s for a, b in sp)) for s, e in hs],
    )
    return m, Xs, Ys, valid, f0
