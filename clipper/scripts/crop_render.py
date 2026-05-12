"""Segment-based renderer for the smart-crop pipeline.

Why segments?
-------------
ffmpeg's `crop` filter has constant width/height (only x/y can be expressions),
so we cannot smoothly switch between "tight 9:16 crop" and "full-frame fit with
blur background" inside a single filter pass.

We therefore:
1. Group the per-frame tracking samples into consecutive segments by
   modeState ('tight' or 'full').
2. Render each segment with the appropriate ffmpeg filter:
   - tight: crop window 9:16 with x = interpolated expression, then scale
   - full:  scale full source into 9:16 with blur background filling the rest
3. Concat all segments + audio with the demuxer concat (lossless).
4. Add subtitles in a final pass (so the .ass overlay covers the whole clip
   including the boundaries).

This produces a single MP4 indistinguishable from a single-pass render except
that mode transitions now exist.

For clips that have only one segment (typical, when scene mode is 'solo' or
the video has continuous face), we short-circuit to the legacy single-pass
filter for speed.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


@dataclass
class CropSegment:
    start: float           # seconds, relative to clip
    end: float             # seconds, relative to clip
    mode_state: str        # "tight" or "full"
    points: list[dict]     # subset of tracking points belonging to this segment
                           # (only used for 'tight' mode)


def group_segments(points: list[dict], min_segment_seconds: float = 0.6) -> list[CropSegment]:
    """Convert annotated tracking points into segments, merging tiny ones."""
    if not points:
        return []

    segments: list[CropSegment] = []
    cur_state = points[0].get("modeState", "tight")
    cur_points: list[dict] = []
    seg_start = float(points[0]["time"])

    for pt in points:
        state = pt.get("modeState", "tight")
        if state != cur_state:
            seg_end = float(pt["time"])
            segments.append(CropSegment(
                start=seg_start,
                end=seg_end,
                mode_state=cur_state,
                points=cur_points,
            ))
            cur_state = state
            cur_points = []
            seg_start = seg_end
        cur_points.append(pt)

    last_time = float(points[-1].get("time", seg_start))
    segments.append(CropSegment(
        start=seg_start,
        end=last_time,
        mode_state=cur_state,
        points=cur_points,
    ))

    # Merge segments shorter than min_segment_seconds into neighbour to avoid flicker
    def _merge(segs: list[CropSegment]) -> list[CropSegment]:
        if len(segs) <= 1:
            return segs
        out: list[CropSegment] = [segs[0]]
        for seg in segs[1:]:
            duration = seg.end - seg.start
            if duration < min_segment_seconds and out:
                # Absorb into previous; keep its mode_state so we don't flicker.
                prev = out[-1]
                prev.end = seg.end
                prev.points.extend(seg.points)
            else:
                out.append(seg)
        # Second pass: merge adjacent same-state segments
        merged: list[CropSegment] = [out[0]]
        for seg in out[1:]:
            if seg.mode_state == merged[-1].mode_state:
                merged[-1].end = seg.end
                merged[-1].points.extend(seg.points)
            else:
                merged.append(seg)
        return merged

    return _merge(segments)


def build_interpolated_x_expr(points: list[dict], source_width: int, output_width: int) -> str:
    """Reproduces the x-expression style from clipper.py but isolated here.

    Returns a string usable as `x='{expr}'` inside ffmpeg crop filter.
    """
    if not points:
        return f"(iw-ow)/2"

    if len(points) == 1:
        ratio = float(points[0]["centerRatio"])
        return f"min(max(iw*{ratio:.6f}-ow/2,0),iw-ow)"

    expr = f"{float(points[-1]['centerRatio']):.6f}"
    for i in range(len(points) - 2, -1, -1):
        start_t = float(points[i]["time"])
        end_t = float(points[i + 1]["time"])
        start_v = float(points[i]["centerRatio"])
        end_v = float(points[i + 1]["centerRatio"])
        duration = max(0.001, end_t - start_t)
        progress = f"min(max((t-{start_t:.3f})/{duration:.3f}\\,0)\\,1)"
        value = f"({start_v:.6f}+({end_v:.6f}-{start_v:.6f})*({progress}))"
        expr = f"if(lt(t\\,{end_t:.3f})\\,{value}\\,{expr})"

    # Wrap into pixel x with clamping.
    return f"min(max(iw*({expr})-ow/2\\,0)\\,iw-ow)"


def tight_filter(width: int, height: int, x_expr: str) -> str:
    """ffmpeg vf for a 9:16 crop window scaled to W x H, x is dynamic."""
    return (
        f"fps=30,scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"setsar=1,crop={width}:{height}:x='{x_expr}':y='(ih-oh)/2'"
    )


def full_filter(width: int, height: int, blur_strength: int = 22) -> str:
    """ffmpeg vf that fits source into W x H with a blurred background fill.

    This is the 'fullscreen / pillar-letterbox with blur' style popularised by
    Submagic / Opus Clip when source is wider than 9:16.
    """
    # Two-stream filter using split + overlay, executed via the lavfi-style
    # `[in]split=2[bg][fg];[bg]...[bgout];[fg]...[fgout];[bgout][fgout]overlay=...`
    return (
        f"fps=30,setsar=1,split=2[bg][fg];"
        f"[bg]scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},boxblur={blur_strength}:1,eq=brightness=-0.05:saturation=1.05[bgout];"
        f"[fg]scale={width}:{height}:force_original_aspect_ratio=decrease[fgout];"
        f"[bgout][fgout]overlay=(W-w)/2:(H-h)/2"
    )


def render_segment(
    *,
    source: Path,
    output: Path,
    seg: CropSegment,
    width: int,
    height: int,
    crf: int,
    blur_strength: int,
    run: Callable[[list[str]], object],
    overlap_seconds: float = 0.0,
) -> None:
    """Render one segment to mp4.

    `overlap_seconds` extends the segment by that amount on the END side so the
    next segment can xfade into it without producing a black/empty frame at the
    boundary (xfade chain consumes the overlap).
    """
    seg_duration = max(0.05, seg.end - seg.start) + max(0.0, float(overlap_seconds))
    if seg.mode_state == "full":
        vf = full_filter(width, height, blur_strength)
    else:
        local_points = []
        for pt in seg.points:
            local_pt = dict(pt)
            local_pt["time"] = max(0.0, float(pt["time"]) - seg.start)
            local_points.append(local_pt)
        x_expr = build_interpolated_x_expr(local_points, width, width)
        vf = tight_filter(width, height, x_expr)

    # Use OUTPUT seek (-ss after -i) to guarantee accurate frame-aligned start
    # without skipping non-keyframe content (eliminates the rare black frame
    # at boundaries observed with input-seek).
    cmd = [
        "ffmpeg", "-y",
        "-fflags", "+genpts",
        "-i", str(source),
        "-ss", f"{seg.start:.3f}",
        "-t", f"{seg_duration:.3f}",
        "-map_metadata", "-1",
        "-vf", f"setpts=PTS-STARTPTS,{vf}",
        "-r", "30",
        "-c:v", "libx264",
        "-profile:v", "high",
        "-level:v", "4.1",
        "-preset", "medium",
        "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        "-g", "60",
        "-bf", "0",
        "-af", "aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS",
        "-c:a", "aac",
        "-ar", "48000",
        "-ac", "2",
        "-b:a", "128k",
        "-avoid_negative_ts", "make_zero",
        "-movflags", "+faststart",
        str(output),
    ]
    run(cmd)


def _ffprobe_duration(path: Path) -> float:
    import subprocess
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True, text=True, check=True,
        )
        return float(result.stdout.strip() or 0.0)
    except Exception:
        return 0.0


def crossfade_combine(
    segment_paths: list[Path],
    output: Path,
    fade_seconds: float,
    crf: int,
    run: Callable[[list[str]], object],
) -> None:
    """Combine pre-rendered segments using xfade + acrossfade chains.

    Eliminates abrupt cuts and black-frame artifacts at segment boundaries.
    """
    if len(segment_paths) < 2 or fade_seconds <= 0.0:
        # Single segment or no fade requested -> simple copy / concat path
        concat_segments(segment_paths, output, run)
        return

    durations = [_ffprobe_duration(p) for p in segment_paths]
    # Clamp fade to half of the shortest segment to avoid xfade complaining.
    max_safe_fade = max(0.05, min(durations) * 0.5 - 0.02)
    fade = min(float(fade_seconds), max_safe_fade)
    if fade <= 0.05:
        concat_segments(segment_paths, output, run)
        return

    inputs: list[str] = []
    for p in segment_paths:
        inputs += ["-i", str(p)]

    parts: list[str] = []

    # Video xfade chain
    cur_v = "[0:v]"
    cum_v = durations[0]
    for i in range(1, len(segment_paths)):
        out_label = f"[vx{i:02d}]" if i < len(segment_paths) - 1 else "[vout]"
        offset = max(0.0, cum_v - fade)
        parts.append(f"{cur_v}[{i}:v]xfade=transition=fade:duration={fade:.3f}:offset={offset:.3f}{out_label}")
        cur_v = out_label
        cum_v = cum_v + durations[i] - fade

    # Audio acrossfade chain (best effort; if any segment has no audio, skip audio)
    has_audio_all = True
    try:
        for p in segment_paths:
            import subprocess
            r = subprocess.run(
                ["ffprobe", "-v", "error", "-select_streams", "a:0",
                 "-show_entries", "stream=index", "-of", "csv=p=0", str(p)],
                capture_output=True, text=True,
            )
            if not r.stdout.strip():
                has_audio_all = False
                break
    except Exception:
        has_audio_all = False

    audio_map = None
    if has_audio_all:
        cur_a = "[0:a]"
        for i in range(1, len(segment_paths)):
            out_a = f"[ax{i:02d}]" if i < len(segment_paths) - 1 else "[aout]"
            parts.append(f"{cur_a}[{i}:a]acrossfade=d={fade:.3f}{out_a}")
            cur_a = out_a
        audio_map = "[aout]"

    cmd: list[str] = ["ffmpeg", "-y"] + inputs + [
        "-filter_complex", ";".join(parts),
        "-map", "[vout]",
    ]
    if audio_map:
        cmd += ["-map", audio_map]
    cmd += [
        "-c:v", "libx264",
        "-profile:v", "high",
        "-level:v", "4.1",
        "-preset", "medium",
        "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        "-g", "60",
        "-bf", "0",
    ]
    if audio_map:
        cmd += ["-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "128k"]
    cmd += ["-movflags", "+faststart", str(output)]

    run(cmd)


def concat_segments(segment_paths: list[Path], output: Path, run: Callable[[list[str]], object]) -> None:
    if not segment_paths:
        raise ValueError("Tidak ada segmen untuk di-concat")
    if len(segment_paths) == 1:
        shutil.copyfile(segment_paths[0], output)
        return
    list_path = output.with_suffix(".concat.txt")
    list_path.write_text(
        "\n".join(f"file '{str(p.resolve()).replace(chr(92), '/')}'" for p in segment_paths),
        encoding="utf-8",
    )
    cmd = [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0",
        "-i", str(list_path),
        "-c", "copy",
        "-movflags", "+faststart",
        str(output),
    ]
    run(cmd)
    try:
        list_path.unlink(missing_ok=True)
    except OSError:
        pass


def burn_subtitles(input_video: Path, ass_path: Path, output: Path, crf: int, run: Callable[[list[str]], object]) -> None:
    """Burn ASS subtitles into a video. Re-encodes to ensure subtitle filter applies."""
    subtitle_path = str(ass_path.resolve()).replace("\\", "/").replace(":", "\\:")
    vf = f"setpts=PTS-STARTPTS,subtitles='{subtitle_path}'"
    cmd = [
        "ffmpeg", "-y",
        "-fflags", "+genpts",
        "-i", str(input_video),
        "-map_metadata", "-1",
        "-vf", vf,
        "-r", "30",
        "-c:v", "libx264",
        "-profile:v", "high",
        "-level:v", "4.1",
        "-preset", "medium",
        "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        "-g", "60",
        "-bf", "0",
        "-af", "aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS",
        "-c:a", "aac",
        "-ar", "48000",
        "-ac", "2",
        "-b:a", "128k",
        "-avoid_negative_ts", "make_zero",
        "-movflags", "+faststart",
        str(output),
    ]
    run(cmd)


def render_segmented_clip(
    *,
    source: Path,
    ass_path: Path | None,
    output: Path,
    segments: list[CropSegment],
    width: int,
    height: int,
    crf: int,
    blur_strength: int,
    job_id: str,
    index: int,
    workdir: Path,
    run: Callable[[list[str]], object],
    log: Callable[[str], None],
    crossfade_seconds: float = 0.4,
) -> None:
    workdir.mkdir(parents=True, exist_ok=True)
    seg_paths: list[Path] = []

    # Each segment except the LAST gets an extra `crossfade_seconds` so the
    # xfade chain has overlap and there is no gap / black frame at boundaries.
    use_crossfade = len(segments) >= 2 and float(crossfade_seconds) > 0.05
    overlap = float(crossfade_seconds) if use_crossfade else 0.0

    for i, seg in enumerate(segments):
        out = workdir / f"{job_id}-clip-{index + 1:02d}-seg-{i + 1:02d}-{seg.mode_state}.mp4"
        seg_overlap = overlap if i < len(segments) - 1 else 0.0
        log(
            f"Render segmen {i + 1}/{len(segments)} mode={seg.mode_state} "
            f"t=[{seg.start:.2f}-{seg.end:.2f}]"
            + (f" +overlap={seg_overlap:.2f}s" if seg_overlap > 0 else "")
        )
        render_segment(
            source=source,
            output=out,
            seg=seg,
            width=width,
            height=height,
            crf=crf,
            blur_strength=blur_strength,
            run=run,
            overlap_seconds=seg_overlap,
        )
        seg_paths.append(out)

    intermediate = workdir / f"{job_id}-clip-{index + 1:02d}-combined.mp4"
    if use_crossfade:
        log(f"Crossfade combine: {len(seg_paths)} segmen, fade={crossfade_seconds:.2f}s")
        crossfade_combine(seg_paths, intermediate, crossfade_seconds, crf, run)
    else:
        concat_segments(seg_paths, intermediate, run)

    if ass_path is None:
        try:
            if output.exists():
                output.unlink()
        except OSError:
            pass
        intermediate.replace(output)
    else:
        burn_subtitles(intermediate, ass_path, output, crf, run)
        try:
            intermediate.unlink(missing_ok=True)
        except OSError:
            pass

    for p in seg_paths:
        try:
            p.unlink(missing_ok=True)
        except OSError:
            pass


__all__ = [
    "CropSegment",
    "group_segments",
    "build_interpolated_x_expr",
    "tight_filter",
    "full_filter",
    "render_segment",
    "concat_segments",
    "crossfade_combine",
    "burn_subtitles",
    "render_segmented_clip",
]
