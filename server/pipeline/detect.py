"""선수 검출. GPU와 ultralytics가 필요하다(11/19 실험의 st2_cache_det.py와 같은 방식)."""
import os
from pathlib import Path
import numpy as np

# 영상 종류별 가중치. 파노라마용은 SoccerTrack v2로 추가 학습한 모델, 스마트폰용은 아직 미확인이라 기본 모델.
WEIGHTS = {
    'panorama': os.environ.get('TL_WEIGHTS_PANORAMA', 'weights/y11s_tile1280_e30_best.pt'),
    'phone': os.environ.get('TL_WEIGHTS_PHONE', 'yolo11s.pt'),
}
CONF = 0.05      # 낮게 저장해 두고 추적 단계에서 기준을 정한다
BATCH = 4


def detect(video: Path, kind: str, on_progress=lambda done, total: None) -> tuple[np.ndarray, dict]:
    """영상 전체 프레임을 원본 해상도로 검출한다. 반환: (frame, x1, y1, x2, y2, conf) 배열과 정보."""
    import cv2
    from ultralytics import YOLO          # 검출 환경이 없는 곳(개발용 PC)에서는 여기서 오류가 난다
    weights = WEIGHTS.get(kind, WEIGHTS['phone'])
    model = YOLO(weights)
    cap = cv2.VideoCapture(str(video))
    W, H, total = int(cap.get(3)), int(cap.get(4)), int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    imgsz = int(np.ceil(W / 32) * 32)
    rows, buf, f = [], [], 0

    def flush():
        nonlocal f
        for r in model.predict(buf, imgsz=imgsz, conf=CONF, classes=[0], device=0, half=True, verbose=False):
            b = r.boxes
            rows.append(np.column_stack([np.full(len(b), f), b.xyxy.cpu().numpy(), b.conf.cpu().numpy()])); f += 1
        buf.clear(); on_progress(f, total)

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        buf.append(frame)
        if len(buf) == BATCH:
            flush()
    if buf:
        flush()
    det = np.concatenate(rows).astype(np.float32) if rows else np.zeros((0, 6), np.float32)
    return det, dict(weights=weights, imgsz=imgsz, conf=CONF, frames=f, width=W, height=H)
