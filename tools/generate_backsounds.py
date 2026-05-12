import math
import random
import struct
import subprocess
import wave
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "assets" / "music"
SAMPLE_RATE = 44100
DURATION_SECONDS = 60


TRACKS = [
    {
        "file": "theme-a-viral-softbeat.mp3",
        "bpm": 96,
        "root": 57,
        "progression": [[0, 4, 7, 11], [-3, 0, 4, 7], [-5, -1, 2, 7], [-2, 2, 5, 9]],
        "melody": [12, 11, 7, 4, 7, 9, 11, 7],
        "swing": 0.08,
        "drive": 0.95,
    },
    {
        "file": "theme-b-inspirasi-lofi.mp3",
        "bpm": 82,
        "root": 55,
        "progression": [[0, 3, 7, 10], [-5, -2, 2, 7], [-3, 0, 3, 7], [-7, -3, 0, 5]],
        "melody": [12, 10, 7, 5, 3, 5, 7, 10],
        "swing": 0.12,
        "drive": 0.70,
    },
    {
        "file": "theme-c-komedi-pop.mp3",
        "bpm": 108,
        "root": 60,
        "progression": [[0, 4, 7, 12], [-5, -1, 2, 7], [-3, 0, 4, 9], [-7, -3, 0, 5]],
        "melody": [12, 7, 12, 14, 16, 14, 12, 7],
        "swing": 0.04,
        "drive": 0.85,
    },
    {
        "file": "theme-d-drama-pulse.mp3",
        "bpm": 90,
        "root": 52,
        "progression": [[0, 3, 7, 10], [-2, 1, 5, 8], [-5, -2, 2, 7], [-1, 2, 6, 9]],
        "melody": [12, 10, 7, 6, 3, 6, 7, 10],
        "swing": 0.02,
        "drive": 1.05,
    },
    {
        "file": "theme-e-fakta-clean.mp3",
        "bpm": 100,
        "root": 59,
        "progression": [[0, 4, 7, 9], [-5, -1, 2, 7], [-2, 2, 5, 9], [-7, -3, 0, 4]],
        "melody": [7, 9, 12, 14, 12, 9, 7, 4],
        "swing": 0.06,
        "drive": 0.75,
    },
]


def midi_to_freq(note):
    return 440.0 * (2 ** ((note - 69) / 12))


def sine(freq, t):
    return math.sin(2 * math.pi * freq * t)


def triangle(freq, t):
    return 2 * abs(2 * ((freq * t) % 1) - 1) - 1


def saw(freq, t):
    return 2 * ((freq * t) % 1) - 1


def pulse_env(position, length=0.26, decay=7.0):
    if position < 0 or position > length:
        return 0.0
    return math.exp(-decay * position)


def nearest_position(beat, grid):
    step = round(beat / grid) * grid
    return (beat - step) * 60


def render_track(track):
    rng = random.Random(track["file"])
    total = SAMPLE_RATE * DURATION_SECONDS
    bpm = track["bpm"]
    beat_seconds = 60.0 / bpm
    samples = []
    peak = 0.0001

    for index in range(total):
        t = index / SAMPLE_RATE
        beat = t / beat_seconds
        bar = int(beat // 4)
        beat_in_bar = beat % 4
        chord = track["progression"][bar % len(track["progression"])]
        drive = track["drive"]

        fade = min(1.0, t / 1.5, (DURATION_SECONDS - t) / 2.0)
        fade = max(0.0, fade)

        pad = 0.0
        for offset in chord:
            freq = midi_to_freq(track["root"] + offset)
            pad += 0.018 * sine(freq, t)
            pad += 0.010 * triangle(freq * 2, t)

        bass_note = track["root"] + chord[0] - 12
        bass_gate = pulse_env((beat % 1) * beat_seconds, 0.42, 5.5)
        bass = 0.09 * triangle(midi_to_freq(bass_note), t) * bass_gate

        step = int((beat * 2 + track["swing"]) % len(track["melody"]))
        step_pos = ((beat * 2 + track["swing"]) % 1) * beat_seconds / 2
        melody_env = pulse_env(step_pos, 0.23, 9.0)
        melody_freq = midi_to_freq(track["root"] + track["melody"][step])
        lead = 0.035 * (sine(melody_freq, t) + 0.35 * saw(melody_freq * 2, t)) * melody_env

        kick_pos = min(abs(beat_in_bar - 0), abs(beat_in_bar - 2)) * beat_seconds
        kick_env = pulse_env(kick_pos, 0.18, 16.0)
        kick = 0.20 * sine(48 + 72 * kick_env, t) * kick_env

        snare_pos = min(abs(beat_in_bar - 1), abs(beat_in_bar - 3)) * beat_seconds
        snare_env = pulse_env(snare_pos, 0.12, 18.0)
        snare = 0.055 * rng.uniform(-1, 1) * snare_env

        hat_pos = abs(nearest_position(beat, 0.5)) * beat_seconds
        hat_env = pulse_env(hat_pos, 0.045, 28.0)
        hat = 0.026 * rng.uniform(-1, 1) * hat_env

        value = (pad + bass + lead + kick + snare + hat) * fade * drive
        value = math.tanh(value * 1.35) * 0.78
        peak = max(peak, abs(value))
        samples.append(value)

    gain = 0.88 / peak
    return [max(-0.98, min(0.98, sample * gain)) for sample in samples]


def write_wav(path, samples):
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        frames = bytearray()
        for sample in samples:
            left = int(sample * 32767)
            right = int(sample * 0.96 * 32767)
            frames.extend(struct.pack("<hh", left, right))
        handle.writeframes(frames)


def encode_mp3(wav_path, mp3_path):
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(wav_path),
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "160k",
            str(mp3_path),
        ],
        check=True,
    )


def normalize_mp3(mp3_path):
    tmp_path = mp3_path.with_suffix(".normalized.mp3")
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-stream_loop",
            "-1",
            "-i",
            str(mp3_path),
            "-t",
            str(DURATION_SECONDS),
            "-ar",
            "48000",
            "-ac",
            "2",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "160k",
            str(tmp_path),
        ],
        check=True,
    )
    tmp_path.replace(mp3_path)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for track in TRACKS:
        mp3_path = OUT_DIR / track["file"]
        wav_path = OUT_DIR / (Path(track["file"]).stem + ".wav")
        if mp3_path.exists():
            print(f"Skipping {mp3_path.name}")
            continue
        print(f"Generating {mp3_path.name}")
        samples = render_track(track)
        write_wav(wav_path, samples)
        encode_mp3(wav_path, mp3_path)
        normalize_mp3(mp3_path)
        wav_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
