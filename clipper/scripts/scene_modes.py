"""Scene-mode presets + state machine.

Each preset bundles tunings for the smart-crop engine:
- detection / switching aggressiveness
- crop tightness (zoom level)
- behavior when face is lost (fullscreen letterbox vs visual fallback vs carry)
- per-mode preferences for active-speaker vs object-of-interest tracking

State machine (per-clip, per-frame): TIGHT  <->  FULLSCREEN
- enters FULLSCREEN after `enter_full_seconds` of low-confidence detection
- exits FULLSCREEN after `exit_full_seconds` of strong face detection
- hard min-hold prevents yo-yo flicker

The state for each tracking sample is annotated as point["modeState"] = "tight"|"full".
Renderer groups consecutive same-state points into segments.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


@dataclass
class SceneMode:
    name: str
    label: str
    description: str

    # No-face fallback strategy: what to do when face confidence is low
    # 'fullscreen' = zoom out to full source frame with blur background (NEW)
    # 'visual'     = jump to visual-saliency center (legacy behavior)
    # 'carry'      = hold last known position
    no_face_strategy: Literal["fullscreen", "visual", "carry"] = "fullscreen"

    # Hysteresis (in seconds) for entering / leaving fullscreen mode
    enter_full_seconds: float = 1.5
    exit_full_seconds: float = 0.8
    min_full_hold_seconds: float = 1.2     # once in full, stay at least this long
    min_tight_hold_seconds: float = 0.6    # once back in tight, stay at least this long

    # Active-speaker scoring weights
    mouth_weight: float = 0.55
    face_weight: float = 0.30
    center_weight: float = 0.05
    stickiness_weight: float = 0.10
    switch_seconds: float = 1.6
    switch_score_margin: float = 0.10
    min_mouth_score_to_switch: float = 0.08

    # Crop smoothing
    smoothing: float = 0.22
    max_shift_per_second: float = 0.06     # hard cap on how far center can move per second

    # Mode shape: how tightly we crop
    # 1.0 = standard 9:16 window matching frame height
    # >1.0 = pull-out (more context), used when face area is small or when we want a "wide shot" feel
    crop_tightness: float = 1.0
    auto_zoom_to_face: bool = False        # zoom-in when face area is large (solo creator look)

    # Initial anchor
    initial_anchor_enabled: bool = True
    initial_scan_seconds: float = 5.0

    # Object-of-interest fallback (for game / sport): use motion + saliency MORE aggressively
    object_focus: bool = False
    object_focus_min_score: float = 0.025

    # Optional override: force scene-mode to NEVER show fullscreen
    disable_fullscreen: bool = False

    # Engine flags
    use_insightface: bool = True
    use_lip_sync: bool = True

    def __post_init__(self):
        if self.disable_fullscreen and self.no_face_strategy == "fullscreen":
            self.no_face_strategy = "visual"


# ---------------------------------------------------------------------------
# Preset registry
# ---------------------------------------------------------------------------

PRESETS: dict[str, SceneMode] = {
    "podcast": SceneMode(
        name="podcast",
        label="Podcast",
        description="2-4 wajah, switch ke active speaker, full-screen saat semua wajah hilang",
        no_face_strategy="fullscreen",
        enter_full_seconds=0.20,
        exit_full_seconds=0.30,
        min_full_hold_seconds=0.45,
        min_tight_hold_seconds=0.20,
        mouth_weight=0.55,
        face_weight=0.25,
        center_weight=0.0,
        stickiness_weight=0.20,
        switch_seconds=1.8,
        switch_score_margin=0.10,
        min_mouth_score_to_switch=0.10,
        smoothing=0.18,
        max_shift_per_second=0.045,
        crop_tightness=1.0,
        auto_zoom_to_face=False,
        initial_anchor_enabled=True,
        initial_scan_seconds=6.0,
        object_focus=False,
    ),
    "solo": SceneMode(
        name="solo",
        label="Solo Creator",
        description="Lock di 1 wajah, zoom otomatis, jarang full-screen",
        no_face_strategy="carry",
        enter_full_seconds=4.0,
        exit_full_seconds=0.4,
        min_full_hold_seconds=1.5,
        min_tight_hold_seconds=0.4,
        mouth_weight=0.40,
        face_weight=0.45,
        center_weight=0.10,
        stickiness_weight=0.05,
        switch_seconds=2.5,
        smoothing=0.30,
        max_shift_per_second=0.12,
        crop_tightness=0.92,
        auto_zoom_to_face=True,
        initial_anchor_enabled=True,
        initial_scan_seconds=4.0,
        object_focus=False,
    ),
    "game": SceneMode(
        name="game",
        label="Game / Gameplay",
        description="Default full-screen gameplay, zoom-in saat ada wajah / aksi intens",
        no_face_strategy="fullscreen",
        enter_full_seconds=0.6,
        exit_full_seconds=1.4,
        min_full_hold_seconds=2.5,
        min_tight_hold_seconds=1.5,
        mouth_weight=0.30,
        face_weight=0.55,
        center_weight=0.05,
        stickiness_weight=0.10,
        switch_seconds=2.0,
        smoothing=0.28,
        max_shift_per_second=0.18,
        crop_tightness=1.20,
        auto_zoom_to_face=True,
        initial_anchor_enabled=False,
        object_focus=True,
        object_focus_min_score=0.020,
    ),
    "reaction": SceneMode(
        name="reaction",
        label="Reaction",
        description="Wajah dominan, hold tight di reaksi",
        no_face_strategy="visual",
        enter_full_seconds=2.5,
        exit_full_seconds=0.4,
        min_full_hold_seconds=1.0,
        min_tight_hold_seconds=0.6,
        mouth_weight=0.50,
        face_weight=0.40,
        center_weight=0.05,
        stickiness_weight=0.05,
        switch_seconds=1.4,
        smoothing=0.22,
        max_shift_per_second=0.10,
        crop_tightness=0.95,
        auto_zoom_to_face=True,
        initial_anchor_enabled=True,
        object_focus=False,
    ),
    "sport": SceneMode(
        name="sport",
        label="Sport / Action",
        description="Ikuti objek tercepat, tracking agresif",
        no_face_strategy="fullscreen",
        enter_full_seconds=0.8,
        exit_full_seconds=1.0,
        min_full_hold_seconds=1.5,
        min_tight_hold_seconds=1.0,
        mouth_weight=0.10,
        face_weight=0.20,
        center_weight=0.10,
        stickiness_weight=0.10,
        switch_seconds=1.0,
        smoothing=0.40,
        max_shift_per_second=0.30,
        crop_tightness=1.10,
        auto_zoom_to_face=False,
        initial_anchor_enabled=False,
        object_focus=True,
        object_focus_min_score=0.015,
    ),
    "auto": SceneMode(
        name="auto",
        label="Auto",
        description="Pilih otomatis berdasar scene; default ke podcast jika ada >=2 wajah",
        no_face_strategy="fullscreen",
        enter_full_seconds=0.55,
        exit_full_seconds=0.45,
        min_full_hold_seconds=0.8,
        min_tight_hold_seconds=0.4,
        mouth_weight=0.50,
        face_weight=0.30,
        center_weight=0.05,
        stickiness_weight=0.15,
        switch_seconds=1.8,
        smoothing=0.22,
        max_shift_per_second=0.08,
        crop_tightness=1.0,
        auto_zoom_to_face=True,
        initial_anchor_enabled=True,
        object_focus=False,
    ),
    "active_speaker": SceneMode(
        # Legacy alias kept for backward compat
        name="active_speaker",
        label="Active Speaker (legacy)",
        description="Mode lama; tanpa fullscreen fallback",
        no_face_strategy="visual",
        disable_fullscreen=True,
        enter_full_seconds=999.0,
        exit_full_seconds=0.0,
        smoothing=0.18,
        max_shift_per_second=0.045,
        initial_anchor_enabled=True,
    ),
    "center": SceneMode(
        name="center",
        label="Center",
        description="Tidak ada smart crop; selalu tengah",
        no_face_strategy="carry",
        disable_fullscreen=True,
        use_insightface=False,
        use_lip_sync=False,
    ),
}


def get_mode(name: str) -> SceneMode:
    key = (name or "auto").strip().lower()
    if key in PRESETS:
        return PRESETS[key]
    # Unknown name: fall back to auto.
    return PRESETS["auto"]


# ---------------------------------------------------------------------------
# State machine for tight <-> fullscreen transitions
# ---------------------------------------------------------------------------

class CropStateMachine:
    """Annotate each tracking sample with `modeState` ('tight'|'full')."""

    def __init__(self, mode: SceneMode, sample_seconds: float):
        self.mode = mode
        self.sample = max(0.05, float(sample_seconds))
        self.state: Literal["tight", "full"] = "tight"
        self._streak_face = 0      # consecutive samples with confident face
        self._streak_no_face = 0   # consecutive samples with no face
        self._held_seconds = 0.0   # how long we've been in current state

        self._enter_full_hits = max(1, int(round(mode.enter_full_seconds / self.sample)))
        self._exit_full_hits = max(1, int(round(mode.exit_full_seconds / self.sample)))
        self._min_hold_full = max(1, int(round(mode.min_full_hold_seconds / self.sample)))
        self._min_hold_tight = max(1, int(round(mode.min_tight_hold_seconds / self.sample)))
        self._held_hits = 0

    def update(self, has_confident_face: bool) -> str:
        if has_confident_face:
            self._streak_face += 1
            self._streak_no_face = 0
        else:
            self._streak_no_face += 1
            self._streak_face = 0

        self._held_hits += 1

        if self.mode.disable_fullscreen:
            self.state = "tight"
            return self.state

        if self.state == "tight":
            if self._streak_no_face >= self._enter_full_hits and self._held_hits >= self._min_hold_tight:
                self.state = "full"
                self._held_hits = 0
        else:  # full
            if self._streak_face >= self._exit_full_hits and self._held_hits >= self._min_hold_full:
                self.state = "tight"
                self._held_hits = 0

        return self.state


__all__ = ["SceneMode", "PRESETS", "get_mode", "CropStateMachine"]
