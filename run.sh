#!/usr/bin/env bash
# Start LyricsTyper on http://127.0.0.1:${PORT:-8000}
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "creating virtualenv…"
  if command -v uv >/dev/null; then
    uv venv -q .venv && uv pip install -q --python .venv/bin/python -r requirements.txt
  else
    python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt
  fi
fi
command -v ffmpeg >/dev/null || echo "note: ffmpeg not found (optional)"
command -v deno >/dev/null || command -v node >/dev/null || echo "warning: yt-dlp needs a JS runtime (deno or node) for YouTube"
echo "LyricsTyper → http://127.0.0.1:${PORT:-8000}"
exec .venv/bin/python -m uvicorn server:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8000}"
