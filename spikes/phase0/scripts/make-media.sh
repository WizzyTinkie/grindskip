#!/bin/sh
# Generates the synthetic test media and the Opus copy of the AAC clip.
#   sweep.webm: 300 -> 6300 Hz linear sweep over 60 s (100 Hz per media
#   second) with a test-pattern video track. The tone's frequency tells which
#   media time is playing, which is how the speed-change lag is measured.
set -eu
mkdir -p "$(dirname "$0")/../media"
cd "$(dirname "$0")/../media"
ffmpeg -v error -y -f lavfi -i "testsrc2=size=320x180:rate=30:duration=60" \
  -f lavfi -i "aevalsrc='0.5*sin(2*PI*(300*t+50*t*t))|0.5*sin(2*PI*(300*t+50*t*t))':s=48000:d=60" \
  -c:v libvpx-vp9 -b:v 200k -deadline realtime -cpu-used 8 -c:a libopus -b:a 192k -shortest sweep.webm
# Separate audio and video files for the MSE test page, which, like
# YouTube, uses a SourceBuffer for each
ffmpeg -v error -y -i sweep.webm -map 0:a -c copy sweep-audio.webm
ffmpeg -v error -y -i sweep.webm -map 0:v -c copy sweep-video.webm
[ -f nocomm_0-120.webm ] || ffmpeg -v error -y -i nocomm_0-120.m4a -c:a libopus -b:a 160k -ar 48000 nocomm_0-120.webm
ls -l sweep.webm nocomm_0-120.webm
