'use strict';
/**
 * CubSentry — server-side HSV transcode.
 *
 * Trigger: a raw clip finalised at  hsv_raw/<player_id>/<clip_id>.mp4
 * Action : transcode to 720p (H.264 / CRF 27, +faststart) with ffmpeg-static,
 *          write the result to  hsv/<player_id>/<display_name>.mp4  with a
 *          download token, append the clip to Players/<player_id>.hsv in
 *          Firestore (arrayUnion), then delete the raw upload.
 *
 * The browser never transcodes — it only uploads the raw file with
 * customMetadata { player_id, clip_id, title, angle, date, display_name }.
 */
const { onObjectFinalized } = require('firebase-functions/v2/storage');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

admin.initializeApp();
const db = admin.firestore();

// Change the region if your project runs elsewhere.
setGlobalOptions({ region: 'us-central1' });

const COLLECTION = 'Players';
const RAW_PREFIX = 'hsv_raw/';
const OUT_PREFIX = 'hsv/';

// Sanitise a value so it is safe to use as part of a Storage object name.
function safe(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim() || 'clip';
}

exports.transcodeHSV = onObjectFinalized(
  { memory: '2GiB', timeoutSeconds: 540, cpu: 2 },
  async (event) => {
    const object = event.data;
    const filePath = object.name || '';

    // Only react to raw uploads; ignore our own transcoded output + everything else.
    if (!filePath.startsWith(RAW_PREFIX)) { return; }
    if (object.metadata && object.metadata.transcoded === 'true') { return; }

    const bucket = admin.storage().bucket(object.bucket);
    const meta = object.metadata || {};
    const playerId = safe(meta.player_id || filePath.split('/')[1] || '');
    const clipId = safe(meta.clip_id || path.basename(filePath, path.extname(filePath)));
    const title = meta.title || 'clip';
    const angle = meta.angle || '';
    const date = meta.date || '';
    const displayName = safe(meta.display_name || (playerId + ' ' + title + (angle ? ' (' + angle + ')' : '')));

    const workIn = path.join(os.tmpdir(), 'in_' + clipId + (path.extname(filePath) || '.mp4'));
    const workOut = path.join(os.tmpdir(), 'out_' + clipId + '.mp4');
    const outPath = OUT_PREFIX + playerId + '/' + displayName + '.mp4';

    logger.info('HSV transcode start', { filePath, playerId, clipId, outPath });

    try {
      // 1) download the raw clip
      await bucket.file(filePath).download({ destination: workIn });

      // 2) transcode -> 720p (same ffmpeg recipe the client used to run)
      await new Promise((resolve, reject) => {
        const args = [
          '-i', workIn,
          '-vf', 'scale=-2:720',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-movflags', '+faststart',
          '-y', workOut,
        ];
        const p = spawn(ffmpegPath, args);
        let err = '';
        p.stderr.on('data', (d) => { err += d.toString(); });
        p.on('error', reject);
        p.on('close', (code) => code === 0
          ? resolve()
          : reject(new Error('ffmpeg exited ' + code + ': ' + err.slice(-1500))));
      });

      // 3) upload the transcoded file with a Firebase download token
      const token = Date.now().toString(36) + Math.random().toString(36).slice(2);
      await bucket.upload(workOut, {
        destination: outPath,
        metadata: {
          contentType: 'video/mp4',
          metadata: { firebaseStorageDownloadTokens: token, transcoded: 'true' },
        },
      });
      const url = 'https://firebasestorage.googleapis.com/v0/b/' + object.bucket +
        '/o/' + encodeURIComponent(outPath) + '?alt=media&token=' + token;

      // 4) append the clip to the player's Firestore document
      const entry = { id: clipId, name: displayName, title, angle, date, url, path: outPath };
      await db.collection(COLLECTION).doc(String(playerId)).set(
        { hsv: admin.firestore.FieldValue.arrayUnion(entry) },
        { merge: true }
      );

      logger.info('HSV transcode done', { outPath });
    } finally {
      // 5) cleanup — always remove temp files; drop the raw upload on success
      try { fs.unlinkSync(workIn); } catch (_) {}
      try { fs.unlinkSync(workOut); } catch (_) {}
      await bucket.file(filePath).delete().catch(() => {});
    }
  }
);
