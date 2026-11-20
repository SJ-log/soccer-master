#!/usr/bin/env bash
# 서버를 띄워 올리기 → 처리 → 결과 → 경기장 맞추기 → 기록 잇기를 한 번 돌려본다(검출·추적은 미리 만든 결과로 대체).
# 사용: tests/smoke_e2e.sh <영상.mp4> <추적결과.txt> [포트]
set -euo pipefail
VIDEO=$1; TRACKS=$2; PORT=${3:-8765}; BASE=http://127.0.0.1:$PORT
export TL_DATA=$(mktemp -d) TL_DEV_TRACKS=$TRACKS
cd "$(dirname "$0")/.."
python3 -m uvicorn server.main:app --port "$PORT" --log-level warning & PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for i in $(seq 30); do curl -sf "$BASE/api/videos" >/dev/null && break; sleep 0.3; done
echo "[올리기]"; ID=$(curl -sf -F "file=@$VIDEO" -F kind=panorama -F name=smoke "$BASE/api/videos" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])"); echo "id=$ID"
for i in $(seq 120); do S=$(curl -sf "$BASE/api/videos/$ID" | python3 -c "import json,sys;j=json.load(sys.stdin)['job'];print(j.get('state'),j.get('error') or '')"); [ "${S%% *}" = done ] && break; [ "${S%% *}" = error ] && { echo "처리 오류: $S"; exit 1; }; sleep 0.5; done
echo "[처리] $S"
curl -sf "$BASE/api/videos/$ID/data" | python3 -c "import json,sys;d=json.load(sys.stdin);print('[결과] 기록',len(d['players']),'개, 위치',d['has_positions'],', 프레임',d['clip']['frames'],', t0',d['clip']['t0'])"
echo "[구간 요청] $(curl -s -o /dev/null -w '%{http_code} %{size_download}' -H 'Range: bytes=0-999' "$BASE/media/$ID/video.mp4")"
echo "[경기장 맞추기] $(curl -sf -H 'Content-Type: application/json' -d '{"model":"plane","points":[{"img":[300,250],"pitch":[-52.5,-34]},{"img":[3800,250],"pitch":[52.5,-34]},{"img":[4000,1000],"pitch":[52.5,34]},{"img":[100,1000],"pitch":[-52.5,34]}]}' "$BASE/api/videos/$ID/calibration")"
FIRST=$(curl -sf "$BASE/api/videos/$ID/data" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['players'][0]['id'])")
echo "[기록 잇기] $(curl -sf -H 'Content-Type: application/json' -d "{\"players\":[{\"name\":\"나\",\"parts\":[{\"track\":$FIRST}]}]}" "$BASE/api/videos/$ID/players")"
curl -sf "$BASE/api/videos/$ID/data" | python3 -c "import json,sys;d=json.load(sys.stdin);p=d['players'][0];print('[다시 계산]',p['name'],p['kind'],'거리',p['distance_m'],'m, 최고',p['top_speed'],'m/s')"
echo "[파노라마는 점 9개 이상] $(curl -s -H 'Content-Type: application/json' -d '{"points":[{"img":[300,250],"pitch":[-52.5,-34]},{"img":[3800,250],"pitch":[52.5,-34]},{"img":[4000,1000],"pitch":[52.5,34]},{"img":[100,1000],"pitch":[-52.5,34]}]}' "$BASE/api/videos/$ID/calibration")"
echo "[잘못된 요청] $(curl -s -o /dev/null -w '%{http_code}' -F 'file=@'"$0" "$BASE/api/videos") $(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/videos/nope/data") $(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"points":[]}' "$BASE/api/videos/$ID/calibration")"
echo "data=$TL_DATA id=$ID"
