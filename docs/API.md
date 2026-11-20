# API

모든 응답은 JSON이다. 오류는 `{"error": "설명"}`과 4xx 상태로 온다.

| 방법 | 주소 | 하는 일 |
|---|---|---|
| POST | `/api/videos` | 영상 올리기(multipart). `file`, `kind`(`panorama`\|`phone`), `name`, `pitch_length`, `pitch_width`. 올리면 처리가 바로 시작된다 |
| GET | `/api/videos` | 올린 영상 목록과 처리 상태 |
| GET | `/api/videos/{id}` | 영상 하나의 정보와 처리 상태 |
| GET | `/api/videos/{id}/data` | 화면용 결과 |
| POST | `/api/videos/{id}/calibration` | 경기장 점 저장 → 위치와 지표 다시 계산 |
| GET | `/api/videos/{id}/players` | 저장된 기록 묶음 |
| POST | `/api/videos/{id}/players` | 이은 기록 묶음 저장 → 지표 다시 계산 |
| GET | `/media/{id}/video.mp4` | 재생용 영상 (구간 요청 지원) |

## 처리 상태 (`job`)

`state`: `queued` → `running` → `done` 또는 `error`. `running`일 때 `step`(`probe`, `prepare`, `detect`, `track`, `package`), `step_label`, `progress`(0~1)가 있다.

## 경기장 맞추기

```json
{"points": [{"img": [300, 250], "pitch": [-52.5, -34]}, ...]}
```

`img`는 영상 픽셀, `pitch`는 경기장 좌표(m, 원점은 경기장 중앙, x는 길이 방향). 4개 이상.
응답의 `residual_m`은 찍은 점에서의 오차(평균, 최대)다.

## 기록 잇기

```json
{"players": [{"name": "나", "parts": [{"track": 12, "from": 0, "to": 900}, {"track": 31}]}]}
```

`track`은 기록 번호, `from`·`to`는 그 기록에서 쓸 프레임 구간(생략하면 전체). 겹치는 프레임은 앞에 적은 조각을 쓴다.

## 화면용 결과 (`data`)

```
key, label, note, has_identity, has_positions
clip      {id, label, fps, frames, width, height, video, t0}
pitch     {length, width}
params    {hsr, sprint, smooth_sec, min_sec, max_gap, grid}
players[] {id, name, kind('player' 사용자가 이은 선수 | 'track' 자동 기록), f0, n, box[n×4], segments, observed_sec,
           pos[n×2]            (경기장을 맞춘 뒤에만. cm 정수, 32767은 위치 없음)
           distance_m, avg_speed, top_speed, hsr_count, hsr_distance_m, sprint_count, zone_share, speed_1hz, fast_runs, jumps}
```

`t0`: 영상 파일에서 첫 화면이 나오는 시각(초). 프레임 번호 = floor((재생 시각 − t0) × fps).
