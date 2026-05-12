"""Dynamic-zoom renderer.

Renders the final 9:16 clip frame-by-frame in Python so the crop window can
have a CONTINUOUSLY VARYING width and x-position - producing a real
"camera pulls back" zoom-out when face confidence drops, and a "camera
zooms in" when face returns. No crossfade dissolve - the transition IS
the zoom.

Architecture:
1. Build keyframes (time, crop_x_ratio, crop_width_ratio, confidence).
2. Apply low-pass smoothing + ease-out so transitions feel cinematic.
3. Per frame: read source via OpenCV, crop the dynamic window, scale to
   1080x1920. If the cropped region is wider than 9:16, fit-with-blur-bg
   (Submagic-style) inside the same output canvas.
4. Pipe raw BGR frames to a single ffmpeg subprocess that muxes the video
   together with the original audio and burns subtitles.

This is significantly slower than ffmpeg-only filters (Python loop +
per-frame cv2.GaussianBlur) but produces the natural transitions the
single-pass filter approach simply cannot.
"""

from __future__ import annotations

import math
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np


@dataclass
class ZoomKeyframe:
    time: float          # seconds
    center_ratio: float  # 0..1, x position of crop center as fraction of source width
    width_ratio: float   # 0..1, crop window width as fraction of source width (1.0 = full)
    confidence: float    # 0..1, face confidence (drives width)


def _ease_in_out(x: float) -> float:
    """Smoothstep cubic. x in [0,1]."""
    x = max(0.0, min(1.0, x))
    return x * x * (3.0 - 2.0 * x)


def _interp(keyframes: list[tuple[float, float]], t: float) -> float:
    """Piecewise-linear interpolation with cubic easing between keyframes."""
    if not keyframes:
        return 0.5
    if t <= keyframes[0][0]:
        return keyframes[0][1]
    if t >= keyframes[-1][0]:
        return keyframes[-1][1]

    lo, hi = 0, len(keyframes) - 1
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if keyframes[mid][0] <= t:
            lo = mid
        else:
            hi = mid
    t0, v0 = keyframes[lo]
    t1, v1 = keyframes[lo + 1]
    if t1 <= t0:
        return v1
    progress = _ease_in_out((t - t0) / (t1 - t0))
    return v0 + (v1 - v0) * progress


def _exp_smooth(values: list[float], alpha: float, reverse_pass: bool = True) -> list[float]:
    """One- or two-pass exponential moving average for smoothing keyframes."""
    if not values:
        return values
    out = [values[0]]
    for v in values[1:]:
        out.append(out[-1] + alpha * (v - out[-1]))
    if reverse_pass:
        rev = [out[-1]]
        for v in reversed(out[:-1]):
            rev.append(rev[-1] + alpha * (v - rev[-1]))
        out = list(reversed(rev))
    return out


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _point_confidence(point: dict) -> float:
    """Face confidence for zoom width.

    New tracker points carry `faceConfidence` (0..1). Older crop JSON only has
    `modeState`, so we keep a compatible fallback: tight=1, full=0.
    """
    if "faceConfidence" in point:
        try:
            return _clamp01(float(point.get("faceConfidence", 0.0)))
        except (TypeError, ValueError):
            pass
    return 0.0 if str(point.get("modeState", "tight")) == "full" else 1.0


def _lead_confidence_drop(times: list[float], confidences: list[float], lead_seconds: float) -> list[float]:
    """Start pull-back slightly before a hard face-loss sample.

    The renderer is offline, so it can see that the next tracking sample loses
    the face. Pulling the confidence down a little before that point prevents
    the viewer from seeing a narrow empty crop first.
    """
    if not times or lead_seconds <= 0:
        return confidences

    out = list(confidences)
    for i in range(1, len(out)):
        if confidences[i - 1] <= 0.55 or confidences[i] >= 0.35:
            continue
        loss_time = times[i]
        loss_conf = confidences[i]
        j = i - 1
        while j >= 0 and loss_time - times[j] <= lead_seconds:
            distance = max(0.0, loss_time - times[j])
            ratio = min(1.0, distance / max(0.001, lead_seconds))
            target = loss_conf + (1.0 - loss_conf) * ratio
            out[j] = min(out[j], target)
            j -= 1
    return out


def _smooth_confidence(
    confidences: list[float],
    *,
    fall_alpha: float = 0.72,
    rise_alpha: float = 0.24,
) -> list[float]:
    """Asymmetric EMA: pull back fast, zoom in gently."""
    if not confidences:
        return confidences
    out = [confidences[0]]
    for value in confidences[1:]:
        previous = out[-1]
        alpha = fall_alpha if value < previous else rise_alpha
        out.append(previous + alpha * (value - previous))
    return [_clamp01(v) for v in out]


def build_zoom_keyframes(
    points: list[dict],
    source_width: int,
    source_height: int,
    target_aspect: float,
    *,
    width_smooth_alpha: float = 0.18,
    center_smooth_alpha: float = 0.30,
    confidence_fall_alpha: float = 0.72,
    confidence_rise_alpha: float = 0.24,
    transition_lead_seconds: float = 0.25,
) -> list[ZoomKeyframe]:
    """Convert tracker points into smoothed zoom keyframes.

    A point's `faceConfidence` drives the target crop width:
        confidence 1.0 -> tight 9:16 crop
        confidence 0.0 -> full source width with blur-fill composition

    A point's `centerRatio` drives the crop x-position.

    Confidence is smoothed asymmetrically: it falls quickly when faces vanish
    and rises gently when faces return. This removes the sudden "camera shock"
    at both ends of a no-face section.
    """
    if not points:
        return []

    tight_width_ratio = max(0.10, min(1.0, (float(source_height) * target_aspect) / float(source_width)))
    times = [float(p.get("time", i)) for i, p in enumerate(points)]
    raw_confidences = [_point_confidence(p) for p in points]
    led_confidences = _lead_confidence_drop(times, raw_confidences, transition_lead_seconds)
    confidences = _smooth_confidence(
        led_confidences,
        fall_alpha=confidence_fall_alpha,
        rise_alpha=confidence_rise_alpha,
    )

    # As confidence drops, ease the camera toward the source center. Once the
    # crop is full-width this no longer changes the image, but during the
    # pull-back it avoids holding a narrow crop over an empty old face position.
    centers = []
    widths = []
    for i, p in enumerate(points):
        face_center = float(p.get("centerRatio", 0.5))
        confidence = confidences[i]
        centers.append(face_center * confidence + 0.5 * (1.0 - confidence))
        widths.append(tight_width_ratio + (1.0 - tight_width_ratio) * (1.0 - confidence))

    centers = _exp_smooth(centers, center_smooth_alpha, reverse_pass=True)
    widths = _exp_smooth(widths, width_smooth_alpha, reverse_pass=True)

    keyframes: list[ZoomKeyframe] = []
    for i, t in enumerate(times):
        keyframes.append(ZoomKeyframe(
            time=t,
            center_ratio=max(0.0, min(1.0, centers[i])),
            width_ratio=max(tight_width_ratio, min(1.0, widths[i])),
            confidence=confidences[i],
        ))
    return keyframes


def _compose_frame(
    frame: np.ndarray,
    *,
    crop_x_center: float,
    crop_width: float,
    out_w: int,
    out_h: int,
    blur_kernel: int,
    blur_sigma: float,
) -> np.ndarray:
    """Crop a window from `frame` and compose it onto a 1080x1920 canvas.

    If the crop is wider than the target aspect, the crop is letterboxed
    into the canvas with a blurred fill of the same crop in the gaps.
    """
    import cv2

    src_h, src_w = frame.shape[:2]
    target_aspect = out_w / float(out_h)

    crop_w = max(2.0, float(crop_width))
    crop_w = min(crop_w, float(src_w))
    crop_w_int = int(round(crop_w))
    crop_w_int -= crop_w_int % 2  # even for codec friendliness

    # Crop is always full source HEIGHT - we only animate width.
    crop_h_int = src_h - (src_h % 2)

    # Clamp x so the crop stays inside source bounds.
    half = crop_w_int / 2.0
    cx = max(half, min(float(src_w) - half, float(crop_x_center)))
    x1 = int(round(cx - half))
    x1 = max(0, min(src_w - crop_w_int, x1))
    x2 = x1 + crop_w_int

    crop = frame[0:crop_h_int, x1:x2]

    crop_aspect = crop_w_int / float(crop_h_int)

    if abs(crop_aspect - target_aspect) <= 0.005:
        # Crop already matches output aspect: simple resize.
        return cv2.resize(crop, (out_w, out_h), interpolation=cv2.INTER_LINEAR)

    if crop_aspect < target_aspect:
        # Crop is TALLER than output (narrower 9:16). Fit by height, blur sides.
        scale = out_h / float(crop_h_int)
        scaled_w = max(2, int(round(crop_w_int * scale)))
        scaled = cv2.resize(crop, (scaled_w, out_h), interpolation=cv2.INTER_LINEAR)
        bg_scale = max(out_w / float(crop_w_int), out_h / float(crop_h_int))
        bg_w = max(2, int(round(crop_w_int * bg_scale)))
        bg_h = max(2, int(round(crop_h_int * bg_scale)))
        bg = cv2.resize(crop, (bg_w, bg_h), interpolation=cv2.INTER_LINEAR)
        bg = cv2.GaussianBlur(bg, (blur_kernel, blur_kernel), blur_sigma)
        bx = max(0, (bg_w - out_w) // 2)
        by = max(0, (bg_h - out_h) // 2)
        out = bg[by:by + out_h, bx:bx + out_w].copy()
        if out.shape[0] != out_h or out.shape[1] != out_w:
            out = cv2.resize(out, (out_w, out_h))
        ox = (out_w - scaled_w) // 2
        out[:, ox:ox + scaled_w] = scaled
        return out

    # Crop is WIDER than output aspect (typical "full" mode):
    # Fit by width, blur top/bottom letterbox.
    scale = out_w / float(crop_w_int)
    scaled_h = max(2, int(round(crop_h_int * scale)))
    scaled = cv2.resize(crop, (out_w, scaled_h), interpolation=cv2.INTER_LINEAR)
    bg_scale = max(out_w / float(crop_w_int), out_h / float(crop_h_int))
    bg_w = max(2, int(round(crop_w_int * bg_scale)))
    bg_h = max(2, int(round(crop_h_int * bg_scale)))
    bg = cv2.resize(crop, (bg_w, bg_h), interpolation=cv2.INTER_LINEAR)
    bg = cv2.GaussianBlur(bg, (blur_kernel, blur_kernel), blur_sigma)
    bx = max(0, (bg_w - out_w) // 2)
    by = max(0, (bg_h - out_h) // 2)
    out = bg[by:by + out_h, bx:bx + out_w].copy()
    if out.shape[0] != out_h or out.shape[1] != out_w:
        out = cv2.resize(out, (out_w, out_h))
    oy = (out_h - scaled_h) // 2
    out[oy:oy + scaled_h, :] = scaled
    return out


def render_dynamic_zoom_clip(
    *,
    source: Path,
    output: Path,
    points: list[dict],
    width: int,
    height: int,
    crf: int,
    blur_strength: int,
    ass_path: Path | None,
    workdir: Path,
    job_id: str,
    index: int,
    log: Callable[[str], None],
    progress: Callable[[float, str], None] | None = None,
    width_smooth_alpha: float = 0.18,
    center_smooth_alpha: float = 0.30,
    confidence_fall_alpha: float = 0.72,
    confidence_rise_alpha: float = 0.24,
    transition_lead_seconds: float = 0.25,
) -> None:
    """Render `source` to `output` with continuous-zoom dynamic crop window.

    `points` come from the tracker and must contain `time`, `centerRatio`,
    `modeState`. The renderer pipes raw BGR frames to ffmpeg which does the
    encoding and audio mux in one process.
    """
    import cv2

    workdir.mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(str(source))
    if not cap.isOpened():
        raise RuntimeError(f"Tidak bisa membuka source clip: {source}")

    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    src_fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if src_w <= 0 or src_h <= 0:
        cap.release()
        raise RuntimeError("Source clip tidak punya dimensi valid.")

    target_aspect = float(width) / float(height)
    keyframes = build_zoom_keyframes(
        points, src_w, src_h, target_aspect,
        width_smooth_alpha=width_smooth_alpha,
        center_smooth_alpha=center_smooth_alpha,
        confidence_fall_alpha=confidence_fall_alpha,
        confidence_rise_alpha=confidence_rise_alpha,
        transition_lead_seconds=transition_lead_seconds,
    )

    if not keyframes:
        keyframes = [ZoomKeyframe(time=0.0, center_ratio=0.5, width_ratio=1.0, confidence=0.0)]

    center_kf = [(k.time, k.center_ratio) for k in keyframes]
    width_kf = [(k.time, k.width_ratio) for k in keyframes]

    intermediate = workdir / f"{job_id}-clip-{index + 1:02d}-zoom-raw.mp4"

    render_fps = 30.0
    blur_kernel = max(3, int(blur_strength) | 1)  # ensure odd
    blur_sigma = max(1.0, float(blur_strength) * 0.6)

    ffmpeg_cmd = [
        "ffmpeg", "-y",
        "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "bgr24",
        "-s", f"{width}x{height}",
        "-r", f"{render_fps:.3f}",
        "-i", "pipe:0",
        "-fflags", "+genpts",
        "-i", str(source),
        "-map", "0:v:0",
        "-map", "1:a:0?",
        "-c:v", "libx264",
        "-profile:v", "high",
        "-level:v", "4.1",
        "-preset", "medium",
        "-crf", str(int(crf)),
        "-pix_fmt", "yuv420p",
        "-g", "60",
        "-bf", "0",
        "-af", "aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS",
        "-c:a", "aac",
        "-ar", "48000",
        "-ac", "2",
        "-b:a", "128k",
        "-shortest",
        "-avoid_negative_ts", "make_zero",
        "-movflags", "+faststart",
        str(intermediate),
    ]

    log(f"Dynamic-zoom render: {frame_count or '?'} frame, fps={render_fps}, blur={blur_kernel}")

    proc = subprocess.Popen(ffmpeg_cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.stdin is None:
        cap.release()
        raise RuntimeError("ffmpeg subprocess tidak bisa dibuka untuk pipe.")

    written = 0
    last_progress_pct = -10.0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break

            t = written / render_fps if render_fps > 0 else 0.0
            cx_ratio = _interp(center_kf, t)
            w_ratio = _interp(width_kf, t)

            crop_width = max(2.0, w_ratio * float(src_w))
            crop_x_center = cx_ratio * float(src_w)

            try:
                composed = _compose_frame(
                    frame,
                    crop_x_center=crop_x_center,
                    crop_width=crop_width,
                    out_w=width,
                    out_h=height,
                    blur_kernel=blur_kernel,
                    blur_sigma=blur_sigma,
                )
            except Exception as exc:
                log(f"compose error frame {written}: {exc}")
                composed = cv2.resize(frame, (width, height))

            try:
                proc.stdin.write(composed.tobytes())
            except (BrokenPipeError, OSError) as exc:
                log(f"ffmpeg pipe rusak di frame {written}: {exc}")
                break

            written += 1
            if progress is not None and frame_count > 0:
                pct = 100.0 * written / float(frame_count)
                if pct - last_progress_pct >= 5.0:
                    progress(pct, f"render frame {written}/{frame_count}")
                    last_progress_pct = pct
    finally:
        cap.release()
        try:
            proc.stdin.close()
        except Exception:
            pass

    err_output = b""
    try:
        err_output = proc.stderr.read() if proc.stderr else b""
    except Exception:
        pass
    rc = proc.wait()
    if rc != 0:
        raise RuntimeError(
            f"ffmpeg dynamic-zoom encode gagal (rc={rc}): {err_output.decode('utf-8', errors='replace')[-600:]}"
        )

    log(f"Dynamic-zoom selesai: {written} frame ditulis -> {intermediate.name}")

    if ass_path is None:
        try:
            if output.exists():
                output.unlink()
        except OSError:
            pass
        intermediate.replace(output)
    else:
        from crop_render import burn_subtitles

        def _run(cmd):
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0:
                raise RuntimeError(f"subtitle burn gagal: {r.stderr[-400:]}")

        burn_subtitles(intermediate, ass_path, output, int(crf), _run)
        try:
            intermediate.unlink(missing_ok=True)
        except OSError:
            pass


__all__ = [
    "ZoomKeyframe",
    "build_zoom_keyframes",
    "render_dynamic_zoom_clip",
]
