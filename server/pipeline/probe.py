"""영상 검사와 재생용 변환."""
import json, subprocess
from pathlib import Path


def probe(path: Path) -> dict:
    """해상도, 초당 프레임 수, 프레임 수, 코덱, 첫 화면이 나오는 시각(t0)을 읽는다.

    t0: 영상 스트림의 시작 시각(초). 브라우저의 재생 시각에서 이만큼 빼야 프레임 번호가 맞는다.
    SoccerTrack v2 클립은 0.99초였다.
    """
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-count_packets',
                          '-show_entries', 'stream=width,height,avg_frame_rate,nb_read_packets,codec_name,start_time,pix_fmt:format=duration',
                          '-of', 'json', str(path)], capture_output=True, text=True, check=True).stdout
    j = json.loads(out); s = j['streams'][0]
    num, den = (s['avg_frame_rate'].split('/') + ['1'])[:2]
    fps = float(num) / float(den or 1)
    return dict(width=int(s['width']), height=int(s['height']), fps=round(fps, 3), frames=int(s['nb_read_packets']),
                codec=s['codec_name'], pix_fmt=s.get('pix_fmt'), t0=round(float(s.get('start_time') or 0), 3),
                duration=round(float(j['format']['duration']), 3))


def browser_playable(info: dict) -> bool:
    """Chrome이 바로 재생할 수 있는 형식인가. 아이폰의 HEVC 영상 등은 변환이 필요하다."""
    return info['codec'] == 'h264' and (info.get('pix_fmt') or 'yuv420p') in ('yuv420p', 'yuvj420p')


def transcode(src: Path, dst: Path) -> None:
    """H.264로 변환한다. 프레임 수와 초당 프레임 수는 바꾸지 않는다."""
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(src), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
                    '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-movflags', '+faststart', str(dst)], check=True)
