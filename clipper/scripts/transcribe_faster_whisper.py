import argparse
import json
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("output")
    parser.add_argument("--language", default="id")
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--cpu-threads", type=int, default=0)
    parser.add_argument("--num-workers", type=int, default=1)
    parser.add_argument("--vad-min-silence-ms", type=int, default=500)
    parser.add_argument("--vad-filter", dest="vad_filter", action="store_true", default=True)
    parser.add_argument("--no-vad-filter", dest="vad_filter", action="store_false")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(
            "faster-whisper belum terinstall. Jalankan: npm run setup:offline",
            file=sys.stderr,
        )
        return 2

    model_kwargs = {
        "device": args.device,
        "compute_type": args.compute_type,
    }
    if args.cpu_threads > 0:
        model_kwargs["cpu_threads"] = args.cpu_threads
    if args.num_workers > 0:
        model_kwargs["num_workers"] = args.num_workers

    print(
        "faster-whisper "
        f"model={args.model} device={args.device} compute={args.compute_type} "
        f"beam={max(1, args.beam_size)} vad={args.vad_filter}",
        file=sys.stderr,
    )

    model = WhisperModel(args.model, **model_kwargs)

    transcribe_kwargs = {
        "language": args.language,
        "vad_filter": args.vad_filter,
        "beam_size": max(1, args.beam_size),
    }
    if args.vad_filter:
        transcribe_kwargs["vad_parameters"] = {
            "min_silence_duration_ms": max(100, args.vad_min_silence_ms)
        }

    segments, info = model.transcribe(args.audio, **transcribe_kwargs)

    result = {
        "language": info.language,
        "language_probability": info.language_probability,
        "segments": [
            {
                "start": float(segment.start),
                "end": float(segment.end),
                "text": segment.text.strip(),
            }
            for segment in segments
            if segment.text and segment.text.strip()
        ],
    }

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
