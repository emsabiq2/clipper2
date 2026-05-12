"""Face detection + active-speaker engine for auto-video-clipper.

Primary detector: InsightFace SCRFD (robust to profile / angles / low light).
Lip-sync metric: MediaPipe FaceMesh (more precise mouth landmarks).
Fallback: motion + visual saliency (computed by caller).

The engine returns per-frame `FaceObservation` objects that include:
- bbox (in source pixel coords)
- 5-point landmarks
- mouth_open_ratio, mouth_motion (lip-sync) when FaceMesh is enabled
- track_id (assigned by SimpleTracker)
- detector_score
"""

from __future__ import annotations

import math
import os
import sys
import threading
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

import numpy as np


# ---------------------------------------------------------------------------
# Shared dataclasses
# ---------------------------------------------------------------------------

@dataclass
class FaceObservation:
    bbox: tuple[float, float, float, float]       # (x1, y1, x2, y2) in source px
    score: float = 0.0                            # detector confidence
    landmarks: list[tuple[float, float]] = field(default_factory=list)
    track_id: int = -1
    mouth_open: float = 0.0                       # 0..1 normalized lip distance / mouth width
    mouth_motion: float = 0.0                     # |mouth_open(t) - mouth_open(t-1)|
    width: float = 0.0
    height: float = 0.0
    cx: float = 0.0
    cy: float = 0.0
    area_ratio: float = 0.0                       # face area / frame area

    @classmethod
    def from_bbox(cls, bbox, frame_w, frame_h, score=1.0, landmarks=None):
        x1, y1, x2, y2 = bbox
        x1 = max(0.0, float(x1))
        y1 = max(0.0, float(y1))
        x2 = min(float(frame_w), float(x2))
        y2 = min(float(frame_h), float(y2))
        w = max(1.0, x2 - x1)
        h = max(1.0, y2 - y1)
        cx = x1 + w / 2.0
        cy = y1 + h / 2.0
        area = w * h
        frame_area = max(1.0, float(frame_w) * float(frame_h))
        return cls(
            bbox=(x1, y1, x2, y2),
            score=float(score),
            landmarks=list(landmarks or []),
            width=w,
            height=h,
            cx=cx,
            cy=cy,
            area_ratio=float(area) / frame_area,
        )


# ---------------------------------------------------------------------------
# InsightFace wrapper (SCRFD detector via onnxruntime)
# ---------------------------------------------------------------------------

class InsightFaceDetector:
    """Wraps insightface FaceAnalysis with model='buffalo_sc' (SCRFD-500MF + landmarks).

    Falls back to 'buffalo_l' if 'buffalo_sc' isn't available.
    """

    _instance_lock = threading.Lock()
    _shared_app = None
    _shared_pack = None

    def __init__(self, det_size=(640, 640), pack=None, providers=None, log=None):
        self.det_size = det_size
        self.pack = pack or os.environ.get("FACE_ENGINE_PACK", "buffalo_sc")
        self.providers = providers or self._default_providers()
        self.log = log or (lambda msg: None)
        self.app = None

    @staticmethod
    def _default_providers():
        try:
            import onnxruntime as ort  # noqa: F401
            avail = ort.get_available_providers()
        except Exception:
            return ["CPUExecutionProvider"]

        # Prefer GPU if user has it. CPU fallback always present.
        order = ["CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider"]
        return [p for p in order if p in avail] or ["CPUExecutionProvider"]

    def load(self):
        if self.app is not None:
            return self

        with InsightFaceDetector._instance_lock:
            if (
                InsightFaceDetector._shared_app is not None
                and InsightFaceDetector._shared_pack == self.pack
            ):
                self.app = InsightFaceDetector._shared_app
                return self

            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                from insightface.app import FaceAnalysis

                # InsightFace will auto-download model pack to ~/.insightface on first use.
                packs_to_try = [self.pack]
                if self.pack != "buffalo_l":
                    packs_to_try.append("buffalo_l")
                if self.pack != "buffalo_s":
                    packs_to_try.append("buffalo_s")

                last_err = None
                for pack in packs_to_try:
                    try:
                        app = FaceAnalysis(
                            name=pack,
                            allowed_modules=["detection", "landmark_2d_106"],
                            providers=self.providers,
                        )
                        app.prepare(ctx_id=0, det_size=self.det_size, det_thresh=0.45)
                        self.app = app
                        InsightFaceDetector._shared_app = app
                        InsightFaceDetector._shared_pack = pack
                        self.log(f"InsightFace siap: pack={pack}, providers={self.providers}")
                        return self
                    except Exception as exc:
                        last_err = exc
                        self.log(f"InsightFace pack '{pack}' gagal: {exc}")

                raise RuntimeError(f"Tidak bisa load InsightFace model pack. Error terakhir: {last_err}")

    def detect(self, frame_bgr) -> list[FaceObservation]:
        if self.app is None:
            self.load()

        try:
            faces = self.app.get(frame_bgr)
        except Exception as exc:
            self.log(f"InsightFace detect error: {exc}")
            return []

        h, w = frame_bgr.shape[:2]
        observations: list[FaceObservation] = []
        for f in faces or []:
            bbox = getattr(f, "bbox", None)
            if bbox is None:
                continue
            score = float(getattr(f, "det_score", 0.0))
            kps = getattr(f, "kps", None)
            landmarks = []
            if kps is not None:
                try:
                    landmarks = [(float(p[0]), float(p[1])) for p in kps]
                except Exception:
                    landmarks = []

            obs = FaceObservation.from_bbox(bbox, w, h, score=score, landmarks=landmarks)
            observations.append(obs)
        return observations


# ---------------------------------------------------------------------------
# MediaPipe FaceMesh - kept ONLY for precise mouth landmarks (lip-sync metric).
# ---------------------------------------------------------------------------

class LipMetricEngine:
    """Compute mouth_open + mouth_motion for given face crops via MediaPipe FaceMesh.

    Used as a per-face supplement on top of InsightFace bboxes; we crop the bbox
    and run FaceMesh on the smaller region for speed and accuracy.
    """

    _LIP_INNER_UPPER = 13
    _LIP_INNER_LOWER = 14
    _LIP_LEFT_CORNER = 61
    _LIP_RIGHT_CORNER = 291

    def __init__(self, max_faces=1, log=None):
        self.max_faces = max(1, int(max_faces))
        self.log = log or (lambda msg: None)
        self._face_mesh = None
        self._available = None

    def _ensure(self):
        if self._available is False:
            return None
        if self._face_mesh is not None:
            return self._face_mesh
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                import mediapipe as mp
            if not hasattr(mp, "solutions") or not hasattr(mp.solutions, "face_mesh"):
                self._available = False
                return None
            self._face_mesh = mp.solutions.face_mesh.FaceMesh(
                static_image_mode=True,
                max_num_faces=self.max_faces,
                refine_landmarks=False,
                min_detection_confidence=0.40,
            )
            self._available = True
            return self._face_mesh
        except Exception as exc:
            self.log(f"FaceMesh tidak tersedia: {exc}")
            self._available = False
            return None

    def measure(self, frame_bgr, observations: list[FaceObservation], previous_mouth_by_track: dict[int, float]):
        face_mesh = self._ensure()
        if face_mesh is None or not observations:
            return

        try:
            import cv2
        except ImportError:
            return

        h, w = frame_bgr.shape[:2]
        for obs in observations:
            x1, y1, x2, y2 = obs.bbox
            # Pad bbox a bit so mouth is inside crop even with imperfect detector.
            pad_x = (x2 - x1) * 0.20
            pad_y = (y2 - y1) * 0.25
            cx1 = int(max(0, x1 - pad_x))
            cy1 = int(max(0, y1 - pad_y))
            cx2 = int(min(w, x2 + pad_x))
            cy2 = int(min(h, y2 + pad_y))
            if cx2 - cx1 < 24 or cy2 - cy1 < 24:
                continue
            crop = frame_bgr[cy1:cy2, cx1:cx2]
            try:
                rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
                result = face_mesh.process(rgb)
            except Exception:
                continue

            if not result.multi_face_landmarks:
                continue

            landmarks = result.multi_face_landmarks[0].landmark
            try:
                upper = landmarks[self._LIP_INNER_UPPER]
                lower = landmarks[self._LIP_INNER_LOWER]
                left = landmarks[self._LIP_LEFT_CORNER]
                right = landmarks[self._LIP_RIGHT_CORNER]
            except IndexError:
                continue

            mouth_open = abs(float(lower.y) - float(upper.y))
            mouth_width = max(0.001, abs(float(right.x) - float(left.x)))
            mouth_open_ratio = mouth_open / mouth_width
            obs.mouth_open = float(mouth_open_ratio)
            prev = previous_mouth_by_track.get(obs.track_id)
            if prev is not None:
                obs.mouth_motion = abs(float(mouth_open_ratio) - float(prev))
            previous_mouth_by_track[obs.track_id] = float(mouth_open_ratio)

    def close(self):
        try:
            if self._face_mesh is not None:
                self._face_mesh.close()
        except Exception:
            pass
        self._face_mesh = None


# ---------------------------------------------------------------------------
# Greedy IOU + center-distance tracker
# ---------------------------------------------------------------------------

class SimpleTracker:
    def __init__(self, iou_threshold=0.20, max_distance_ratio=0.18, max_lost=15):
        self.iou_threshold = float(iou_threshold)
        self.max_distance_ratio = float(max_distance_ratio)
        self.max_lost = int(max_lost)
        self._tracks: dict[int, dict] = {}
        self._next_id = 1

    def _iou(self, a, b):
        ax1, ay1, ax2, ay2 = a
        bx1, by1, bx2, by2 = b
        ix1, iy1 = max(ax1, bx1), max(ay1, by1)
        ix2, iy2 = min(ax2, bx2), min(ay2, by2)
        iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
        inter = iw * ih
        ua = (ax2 - ax1) * (ay2 - ay1)
        ub = (bx2 - bx1) * (by2 - by1)
        denom = ua + ub - inter
        return inter / denom if denom > 0 else 0.0

    def update(self, observations: list[FaceObservation], frame_w: int, frame_h: int):
        if not observations:
            for tid in list(self._tracks.keys()):
                self._tracks[tid]["lost"] += 1
                if self._tracks[tid]["lost"] > self.max_lost:
                    del self._tracks[tid]
            return observations

        # Sort observations by area (bigger faces first) for stable assignment.
        observations = sorted(observations, key=lambda o: o.area_ratio, reverse=True)
        used = set()
        diag = math.hypot(frame_w, frame_h) or 1.0

        for obs in observations:
            best_id = None
            best_score = 0.0
            for tid, track in self._tracks.items():
                if tid in used:
                    continue
                iou = self._iou(obs.bbox, track["bbox"])
                dist = math.hypot(obs.cx - track["cx"], obs.cy - track["cy"]) / diag
                if dist > self.max_distance_ratio:
                    continue
                score = iou + max(0.0, 0.5 - dist)
                if score > best_score and (iou >= self.iou_threshold or dist < self.max_distance_ratio * 0.5):
                    best_score = score
                    best_id = tid
            if best_id is None:
                best_id = self._next_id
                self._next_id += 1
                self._tracks[best_id] = {"bbox": obs.bbox, "cx": obs.cx, "cy": obs.cy, "lost": 0}
            else:
                self._tracks[best_id]["bbox"] = obs.bbox
                self._tracks[best_id]["cx"] = obs.cx
                self._tracks[best_id]["cy"] = obs.cy
                self._tracks[best_id]["lost"] = 0
            obs.track_id = int(best_id)
            used.add(best_id)

        for tid in list(self._tracks.keys()):
            if tid not in used:
                self._tracks[tid]["lost"] += 1
                if self._tracks[tid]["lost"] > self.max_lost:
                    del self._tracks[tid]

        return observations


# ---------------------------------------------------------------------------
# Public unified engine
# ---------------------------------------------------------------------------

class FaceEngine:
    """Bundle: InsightFace detector + tracker + (optional) lip metric."""

    def __init__(self, config, log=None):
        self.config = config
        self.log = log or (lambda msg: None)
        det_size = int(config.get("face_engine_det_size", 640))
        self.detector = InsightFaceDetector(
            det_size=(det_size, det_size),
            pack=str(config.get("face_engine_pack", "buffalo_sc")),
            log=self.log,
        )
        self.tracker = SimpleTracker(
            iou_threshold=float(config.get("face_engine_iou", 0.20)),
            max_distance_ratio=float(config.get("face_engine_max_dist", 0.18)),
            max_lost=int(config.get("face_engine_max_lost", 15)),
        )
        self.lip = LipMetricEngine(
            max_faces=int(config.get("active_speaker_max_faces", 4)),
            log=self.log,
        )
        self._lip_history: dict[int, float] = {}
        self._last_frame_w = 0
        self._last_frame_h = 0
        self._loaded = False

    def load(self):
        if self._loaded:
            return self
        self.detector.load()
        self._loaded = True
        return self

    def process(self, frame_bgr) -> list[FaceObservation]:
        if not self._loaded:
            self.load()
        h, w = frame_bgr.shape[:2]
        self._last_frame_w = w
        self._last_frame_h = h
        observations = self.detector.detect(frame_bgr)
        observations = self.tracker.update(observations, w, h)
        if observations:
            self.lip.measure(frame_bgr, observations, self._lip_history)
        return observations

    def close(self):
        try:
            self.lip.close()
        except Exception:
            pass


__all__ = [
    "FaceObservation",
    "InsightFaceDetector",
    "LipMetricEngine",
    "SimpleTracker",
    "FaceEngine",
]
