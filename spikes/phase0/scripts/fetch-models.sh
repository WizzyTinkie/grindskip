#!/bin/sh
# Downloads the Silero VAD models compared in Phase 0, pinned to commits.
set -eu
cd "$(dirname "$0")/../models"
base=https://raw.githubusercontent.com/snakers4/silero-vad
get() { [ -f "$2" ] || curl -sSfL -o "$2" "$base/$1/src/silero_vad/data/$3"; }
get bfdc0193023f121ea5b3cc7b176dbed570a68a59 silero_vad_v6.2.onnx       silero_vad.onnx
get bfdc0193023f121ea5b3cc7b176dbed570a68a59 silero_vad_v6.2_16k.onnx   silero_vad_16k_op15.onnx
get 6478567951ae5c9979ad7b234185b5515f4be7a1 silero_vad_v5.1.2.onnx     silero_vad.onnx
sha256sum *.onnx
