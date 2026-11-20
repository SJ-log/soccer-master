"""화면 좌표 -> 경기장 좌표(m). 사용자가 찍은 점으로 변환 행렬을 맞춘다.

경기장 좌표의 원점은 경기장 중앙이고, x는 길이 방향, y는 폭 방향이다.
지금은 평면 변환(호모그래피) 하나만 쓴다. 화면이 휘어 있는 파노라마 영상은 오차가 더 크다(개선 예정).
"""
import numpy as np
import cv2

MIN_POINTS = 4


def fit(points: list[dict]) -> dict:
    """points: [{'img': [x, y], 'pitch': [X, Y]}, ...] (4개 이상). 반환: 변환 행렬과 찍은 점에서의 잔차(m)."""
    if len(points) < MIN_POINTS:
        raise ValueError(f'점이 {MIN_POINTS}개 이상 필요합니다 (지금 {len(points)}개)')
    img = np.array([p['img'] for p in points], dtype=np.float64); pitch = np.array([p['pitch'] for p in points], dtype=np.float64)
    H, _ = cv2.findHomography(img, pitch, 0)
    if H is None:
        raise ValueError('점의 배치로는 변환을 구할 수 없습니다 (한 줄로 늘어서 있지 않은지 확인)')
    res = np.hypot(*(to_pitch(img, H) - pitch).T)
    return dict(H=H.tolist(), residual_m=dict(mean=round(float(res.mean()), 2), max=round(float(res.max()), 2)), points=len(points))


def to_pitch(foot: np.ndarray, H) -> np.ndarray:
    """foot: (n, 2) 화면 px -> (n, 2) 경기장 m"""
    return cv2.perspectiveTransform(np.asarray(foot, dtype=np.float64).reshape(-1, 1, 2), np.asarray(H, dtype=np.float64)).reshape(-1, 2)
