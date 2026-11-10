#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "$0")/.." && pwd)
dist_root="$project_root/dist"

rm -rf "$dist_root"
mkdir -p "$dist_root/server" "$dist_root/.openai"
node "$project_root/scripts/font-data.mjs"
cp "$project_root/.openai/hosting.json" "$dist_root/.openai/hosting.json"
# Sites consumes migration sidecars at this path before uploading the Worker.
# Match @openai/sites-vite-plugin: preserve SQL and any existing Drizzle metadata.
cp -R "$project_root/drizzle" "$dist_root/.openai/drizzle"

echo "Built $dist_root"
