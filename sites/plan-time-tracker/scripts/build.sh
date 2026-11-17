#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "$0")/.." && pwd)
dist_root="$project_root/dist"

rm -rf "$dist_root"
mkdir -p "$dist_root/server" "$dist_root/.openai"
node "$project_root/scripts/font-data.mjs"
"$project_root/node_modules/.bin/esbuild" "$project_root/worker/index.js" --bundle --format=esm --platform=neutral --charset=utf8 --outfile="$dist_root/server/index.js"
# Sites consumes migration sidecars at this path before uploading the Worker.
# Match @openai/sites-vite-plugin: preserve SQL and any existing Drizzle metadata.
cp -R "$project_root/drizzle" "$dist_root/.openai/drizzle"

echo "Built $dist_root"
