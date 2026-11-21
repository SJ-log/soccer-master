"""경기장 선과, 사용자가 찍을 수 있는 점의 목록. 좌표는 m, 원점은 경기장 중앙, x는 길이 방향.

길이와 폭은 영상마다 다르게 받을 수 있지만, 벌칙 구역 같은 표시의 크기는 11인제 규격으로 고정한다.
(풋살장처럼 표시 규격이 다른 경기장은 모서리·중앙선·중앙점만 맞다.)
"""
import math

PEN_DEPTH, PEN_HALF = 16.5, 20.16      # 벌칙 구역: 골라인에서 16.5m, 폭 40.32m
GOAL_DEPTH, GOAL_HALF = 5.5, 9.16      # 골 구역: 5.5m, 폭 18.32m
POST_HALF, SPOT, CIRCLE = 3.66, 11.0, 9.15
ARC_HALF = math.sqrt(CIRCLE ** 2 - (PEN_DEPTH - SPOT) ** 2)       # 벌칙 호가 벌칙 구역 선과 만나는 곳


def landmarks(length: float, width: float) -> list[dict]:
    """선이 만나는 곳: 화면에서 정확한 위치를 알 수 있는 점"""
    hl, hw = length / 2, width / 2; out = []
    def add(key, name, x, y, group): out.append(dict(id=key, name=name, pitch=[round(x, 3), round(y, 3)], group=group))
    for sx, side in ((-1, '왼쪽'), (1, '오른쪽')):
        for sy, far in ((-1, '먼 쪽'), (1, '가까운 쪽')):
            k = ('L' if sx < 0 else 'R') + ('F' if sy < 0 else 'N')
            add('corner' + k, f'{side} {far} 모서리', sx * hl, sy * hw, 'corner')
            add('penLine' + k, f'{side} 벌칙 구역 · 골라인 {far}', sx * hl, sy * PEN_HALF, 'pen')
            add('penIn' + k, f'{side} 벌칙 구역 · 안쪽 모서리 {far}', sx * (hl - PEN_DEPTH), sy * PEN_HALF, 'pen')
            add('goalLine' + k, f'{side} 골 구역 · 골라인 {far}', sx * hl, sy * GOAL_HALF, 'goal')
            add('goalIn' + k, f'{side} 골 구역 · 안쪽 모서리 {far}', sx * (hl - GOAL_DEPTH), sy * GOAL_HALF, 'goal')
            add('post' + k, f'{side} 골대 {far}', sx * hl, sy * POST_HALF, 'post')
            add('arc' + k, f'{side} 벌칙 호 끝 {far}', sx * (hl - PEN_DEPTH), sy * ARC_HALF, 'arc')
        add('spot' + ('L' if sx < 0 else 'R'), f'{side} 벌칙점', sx * (hl - SPOT), 0, 'spot')
    for sy, far in ((-1, '먼 쪽'), (1, '가까운 쪽')):
        k = 'F' if sy < 0 else 'N'
        add('half' + k, f'중앙선 끝 {far}', 0, sy * hw, 'half'); add('circle' + k, f'중앙원 · 중앙선 {far}', 0, sy * CIRCLE, 'half')
    add('center', '중앙점', 0, 0, 'half')
    return out


def lines(length: float, width: float) -> list[dict]:
    """곧은 선: 그 위의 아무 곳이나 찍을 수 있다(어느 선 위인지만 안다). span은 그림에 그릴 범위"""
    hl, hw = length / 2, width / 2
    return [dict(id='touchF', name='먼 쪽 터치라인', axis='y', value=-hw, span=[-hl, hl]), dict(id='touchN', name='가까운 쪽 터치라인', axis='y', value=hw, span=[-hl, hl]),
            dict(id='goalL', name='왼쪽 골라인', axis='x', value=-hl, span=[-hw, hw]), dict(id='goalR', name='오른쪽 골라인', axis='x', value=hl, span=[-hw, hw]),
            dict(id='halfway', name='중앙선', axis='x', value=0.0, span=[-hw, hw])]


def shapes(length: float, width: float, step: float = 1.0) -> list[list[list[float]]]:
    """경기장 선을 꺾은선으로. 그림을 그리거나, 영상 위에 다시 그려 맞춤 결과를 확인할 때 쓴다."""
    hl, hw = length / 2, width / 2
    def seg(a, b):
        n = max(2, int(math.hypot(b[0] - a[0], b[1] - a[1]) / step) + 1)
        return [[a[0] + (b[0] - a[0]) * i / (n - 1), a[1] + (b[1] - a[1]) * i / (n - 1)] for i in range(n)]
    def rect(x0, x1, y):
        return seg((x0, -y), (x1, -y)) + seg((x1, -y), (x1, y)) + seg((x1, y), (x0, y))
    def arc(cx, cy, r, a0, a1):
        n = max(8, int(abs(a1 - a0) * r / step)); return [[cx + r * math.cos(a0 + (a1 - a0) * i / n), cy + r * math.sin(a0 + (a1 - a0) * i / n)] for i in range(n + 1)]
    out = [seg((-hl, -hw), (hl, -hw)), seg((hl, -hw), (hl, hw)), seg((hl, hw), (-hl, hw)), seg((-hl, hw), (-hl, -hw)), seg((0, -hw), (0, hw)), arc(0, 0, CIRCLE, 0, 2 * math.pi)]
    a = math.acos((PEN_DEPTH - SPOT) / CIRCLE)
    for s in (-1, 1):
        out += [rect(s * hl, s * (hl - PEN_DEPTH), PEN_HALF), rect(s * hl, s * (hl - GOAL_DEPTH), GOAL_HALF)]
        out.append(arc(s * (hl - SPOT), 0, CIRCLE, -a, a) if s < 0 else arc(s * (hl - SPOT), 0, CIRCLE, math.pi - a, math.pi + a))
    return [[[round(x, 2), round(y, 2)] for x, y in line] for line in out]
