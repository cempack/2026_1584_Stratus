import numpy as np
import pytest

pytest.importorskip("faster_whisper")
from stratus.captions import FRAME, RATE, Splitter, plausible  # noqa: E402


def tone(seconds, amp=0.2):
    t = np.arange(int(seconds * RATE)) / RATE
    return (amp * np.sin(2 * np.pi * 440 * t)).astype(np.float32)


def silence(seconds, amp=0.0005):
    return (amp * np.random.default_rng(0).standard_normal(int(seconds * RATE))).astype(np.float32)


def test_splits_one_transmission_per_squelch_break():
    sp = Splitter()
    audio = np.concatenate([silence(1), tone(2), silence(1.2), tone(1.5), silence(1.2)])
    out = []
    for i in range(0, len(audio), 1600):  # 100 ms chunks, like the decoder hands them over
        out += sp.push(audio[i:i + 1600], now=i / RATE)
    assert len(out) == 2
    assert 2.0 <= len(out[0][1]) / RATE <= 3.2 and 1.5 <= len(out[1][1]) / RATE <= 2.7


def test_ignores_clicks_and_caps_long_carrier():
    sp = Splitter()
    out = sp.push(np.concatenate([silence(1), tone(0.1), silence(1.5)]), 0)
    assert out == []
    out = sp.push(tone(25), 0)
    assert len(out) >= 1 and all(len(o[1]) / RATE <= 12.5 for o in out)  # capped; a steady carrier becomes "floor"
    assert len(out[0][1]) % FRAME == 0


def test_plausibility_filter():
    assert plausible("JetBlue 1737, turn right heading 100, contact departure")
    assert not plausible("渡船, 温泉, 车, 银行, 行")
    assert not plausible("Air traffic control radio. Runway, cleared for takeoff, cleared")
    assert not plausible("Thank you.")
    assert plausible("Roger, runway 25, cleared for takeoff")
    assert not plausible("The")
