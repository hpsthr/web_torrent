#!/usr/bin/env bash
# Builds small test videos: one browser-safe MKV (h264 8-bit + aac) that should
# REMUX, and one 10-bit MKV that must be RE-ENCODED, plus a decoy text file that
# must never be downloaded.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p fixtures
cd fixtures

if [ ! -f sample-h264-8bit.mkv ]; then
  echo "building sample-h264-8bit.mkv …"
  ffmpeg -y -v error \
    -f lavfi -i "testsrc2=size=1280x720:rate=25" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000" \
    -t 40 -shortest \
    -c:v libx264 -preset veryfast -crf 27 -pix_fmt yuv420p -g 50 \
    -c:a aac -b:a 96k \
    sample-h264-8bit.mkv
fi

if [ ! -f sample-h264-10bit.mkv ]; then
  echo "building sample-h264-10bit.mkv …"
  ffmpeg -y -v error \
    -f lavfi -i "testsrc2=size=960x540:rate=25" \
    -f lavfi -i "sine=frequency=660:sample_rate=48000" \
    -t 20 -shortest \
    -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p10le -profile:v high10 \
    -c:a aac -b:a 96k \
    sample-h264-10bit.mkv
fi

printf 'This decoy file must never be downloaded by the app.\n' > README-decoy.txt

ls -lh
