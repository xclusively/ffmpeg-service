# FFmpeg Service — Documentation

> The video transcoding worker. Turns an uploaded video into multiple
> lower‑resolution variants for smooth playback on any connection.

- **Port:** 8567
- **Stack:** Node.js, Express, Bull (Redis‑backed queue), FFmpeg, Hetzner S3
- **Owns:** no DB tables — it's a media worker.

---

## 1. How transcoding works

1. **post‑service** uploads the original video to Hetzner S3 (`public/uploads/<userId>-<ts>-<name>.mp4`) and calls `POST /transcode` with `{ fileKey, mediaContent (base64) }`.
2. ffmpeg‑service adds a job to a **Bull queue** (Redis‑backed).
3. The worker writes the base64 to `/tmp/videos/input-xxx.mp4`.
4. `docker exec ffmpeg-worker ffprobe …` reads the file for real dimensions.
5. `getTargetsBelowSource(sourceHeight, …)` decides which variants to create — **only resolutions strictly below the source height** (the source is already uploaded and never re‑created). E.g. 1080p → 720p, 480p, 360p.
6. For each variant, up to **5 FFmpeg strategies** are tried (optimal → conservative → simple → fast re‑encode → last resort). All use `scale=-2:HEIGHT` to preserve aspect ratio for both landscape and portrait.
7. On success the variant is uploaded to Hetzner S3 and the temp file deleted.

---

## 2. Shared‑volume architecture

The `ffmpeg-service` API and the `ffmpeg-worker` container must mount the **same host path** `/tmp/xclusively-videos` → `/tmp/videos` (a **bind mount**, not a named Docker volume — avoids compose project‑name prefix issues). The worker also needs the docker socket mounted (`/var/run/docker.sock:ro`) so `docker exec` can run `ffprobe`/`ffmpeg` in the worker.

---

## 3. Operational notes

- **Env / infra:** Redis (Bull queue), Hetzner S3 credentials, the shared bind mount + docker socket (wired in the Jenkinsfile + compose).
- CommonJS (converted from ESM); Node 20 global `fetch` (no `node-fetch`).
- Correct aspect‑ratio handling (`scale=-2:HEIGHT`) is critical — earlier bugs distorted portrait video.
