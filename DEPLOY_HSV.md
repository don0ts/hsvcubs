# CubSentry — server-side HSV transcode: deploy guide

The browser now uploads the **raw** clip only. A Cloud Function transcodes it to
720p on the server, writes the final file, and adds it to the player's record.
Nothing heavy runs in the browser anymore.

```
browser  ->  hsv_raw/<player_id>/<clip_id>.mp4   (raw upload + customMetadata)
              |
              v  transcodeHSV (Cloud Function, ffmpeg -> 720p)
storage  ->  hsv/<player_id>/<display_name>.mp4  (720p, +faststart, download token)
firestore->  Players/<player_id>.hsv  (arrayUnion new clip)
raw file  deleted
```

## One-time setup

1. Install the Firebase CLI and sign in:
   ```bash
   npm install -g firebase-tools
   firebase login
   ```
2. From your project folder, point the CLI at the project:
   ```bash
   firebase use cubsentry
   ```
   If you have never run `firebase init` here, run `firebase init functions`
   once and pick **JavaScript / Node 20**, then replace the generated
   `functions/index.js` and `functions/package.json` with the ones shipped here.

## Files in this bundle

- `functions/index.js`     — the `transcodeHSV` Cloud Function (v2, Node 20).
- `functions/package.json` — dependencies (firebase-admin, firebase-functions, ffmpeg-static).
- `storage.rules`          — Storage rules allowing raw video uploads + reads.
- `cors.json`              — (from the previous step) CORS for direct uploads.

## Deploy

```bash
# 1) install function deps
cd functions && npm install && cd ..

# 2) apply CORS to the bucket (lets the browser upload directly)
gsutil cors set cors.json gs://cubsentry.firebasestorage.app

# 3) deploy Storage rules
firebase deploy --only storage

# 4) deploy the function
firebase deploy --only functions
```

First deploy may ask to enable the Cloud Functions / Cloud Build / Artifact
Registry APIs — accept. The function needs the **Blaze (pay-as-you-go)** plan
because it uses outbound bandwidth + more memory.

## Settings baked into the function

- Trigger: Storage object finalized under `hsv_raw/`.
- Memory 2 GiB, CPU 2, timeout 540 s (enough for large high-fps HSV files).
- ffmpeg recipe: `scale=-2:720 -c:v libx264 -preset veryfast -crf 27 -movflags +faststart`.
- Region `us-central1` — change `setGlobalOptions({ region: ... })` in
  `index.js` if your other resources live elsewhere.

## Verify after deploy

1. Open the page over **https** (`https://cubsentry.web.app/...`), never `file://`.
2. Upload a clip — the modal's log panel shows MB/s and a stall counter while the
   raw file uploads, then “queued for server transcode”.
3. Watch the function run:
   ```bash
   firebase functions:log --only transcodeHSV
   ```
4. Within a minute or so the 720p clip appears under **Play HSV** for that
   player (Firestore `onSnapshot` updates the row live).

## If an upload hangs at 0%

That is a **configuration** issue, not the code: Storage CORS not applied,
Security Rules denying the write, or Storage not enabled on the bucket. The log
panel + the browser console (F12) will show the exact network error. Re-check
steps 2–3 above.
