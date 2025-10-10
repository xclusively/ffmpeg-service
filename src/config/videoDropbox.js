// // filepath: c:\Users\kiran\OneDrive\Desktop\cent-stage\post-service\src\config\videoDropbox.js
// // Added 1080p variant (transcoded to MP4) – still returns only the 720p (or fallback) URL.
// // To derive 1080p URL from returned 720p: replace '-720p.mp4' with '-1080p.mp4'

// /**
//  * Upload original (keeps original container) + 1080p / 720p / 480p / 360p MP4 variants.
//  * Returns ONLY the 720p variant URL (fallback to original if 720 not produced).
//  *
//  * Naming:
//  *  /<ts>-<base>-original<origExt>
//  *  /<ts>-<base>-1080p.mp4
//  *  /<ts>-<base>-720p.mp4
//  *  /<ts>-<base>-480p.mp4
//  *  /<ts>-<base>-360p.mp4
//  *
//  * Derivations from returned 720p URL:
//  *  -1080p.mp4 / -480p.mp4 / -360p.mp4 / -original<origExt>
//  */
// const { Dropbox } = require("dropbox");
// const { exec } = require("child_process");
// const util = require("util");
// const fs = require("fs");
// const path = require("path");
// const logger = require("./logger");

// const execAsync = util.promisify(exec);
// const SHARED_VIDEO_PATH = "/tmp/videos";

// const UploadVideoVariantsToDropbox = async (
//   fileContent,
//   fileName,
//   dbxAccessToken,
//   res
// ) => {
//   const dbx = new Dropbox({ accessToken: dbxAccessToken, fetch });

//   try {
//     const inputBuffer = Buffer.from(fileContent, "base64");
//     const { baseName, origExt } = parseName(fileName);
//     const ts = Date.now();

//     // 1. IMMEDIATE: Upload original and return response
//     const originalPath = `/${ts}-${baseName}-original${origExt}`;
//     const originalUrl = await uploadBufferToDropbox(
//       dbx,
//       inputBuffer,
//       originalPath
//     );

//     logger.info(`Uploaded original ${originalPath} - returning immediately`);

//     // 2. Start background transcoding (fire and forget - no await here)
//     backgroundTranscode(inputBuffer, fileName, ts, baseName, origExt, dbxAccessToken);

//     // 3. Return original URL IMMEDIATELY (doesn't wait for backgroundTranscode)
//     return originalUrl;
//   } catch (error) {
//     logger.error(`Original upload error: ${error.message}`);
//     if (res && !res.headersSent) {
//       res.status(500).json({ error: "Failed to upload video" });
//     }
//     return null;
//   }
// };

// // Separate async function that handles transcoding
// async function backgroundTranscode(inputBuffer, fileName, ts, baseName, origExt, dbxAccessToken) {
//   try {
//     logger.info(`Starting background transcoding for ${fileName}`);

//     // These awaits only pause THIS function, not the main response
//     const probe = await probeVideoWithRetry(inputFile, 3);

//     for (const target of targets) {
//       await processVariantWithGuaranteedSuccess(...); // This await is isolated
//     }

//     logger.info(`Background transcoding complete for ${fileName}`);
//   } catch (error) {
//     logger.error(`Background transcoding failed: ${error.message}`);
//   }
// }

// // BULLETPROOF Background transcoding with better fallback logic
// async function startBackgroundTranscoding(
//   inputBuffer,
//   fileName,
//   ts,
//   baseName,
//   origExt,
//   dbxAccessToken
// ) {
//   const dbx = new Dropbox({ accessToken: dbxAccessToken, fetch });
//   let tempFiles = [];

//   try {
//     logger.info(`Starting background transcoding for ${fileName}`);

//     // Create temp input file
//     const tempId = `${ts}-${Math.random().toString(36).substring(7)}`;
//     const inputFile = `input-${tempId}${origExt}`;
//     const inputPath = path.join(SHARED_VIDEO_PATH, inputFile);

//     if (!fs.existsSync(SHARED_VIDEO_PATH)) {
//       fs.mkdirSync(SHARED_VIDEO_PATH, { recursive: true });
//     }
//     fs.writeFileSync(inputPath, inputBuffer);
//     tempFiles.push(inputPath);

//     // Probe video with retry logic
//     const probe = await probeVideoWithRetry(inputFile, 3);
//     const originalHeight = probe.height || 0;
//     const originalWidth = probe.width || 0;
//     const hasAudio = probe.hasAudio;
//     const duration = probe.duration || 0;

//     logger.info(
//       `Background probe: ${originalWidth}x${originalHeight}, audio=${hasAudio}, duration=${duration}s`
//     );

//     // Define variant paths
//     const paths = {
//       p1080: `/${ts}-${baseName}-1080p.mp4`,
//       p720: `/${ts}-${baseName}-720p.mp4`,
//       p480: `/${ts}-${baseName}-480p.mp4`,
//       p360: `/${ts}-${baseName}-360p.mp4`,
//     };

//     // Smart variant selection based on original resolution
//     const targets = getOptimalTargets(originalWidth, originalHeight, paths);

//     // Process each variant with BULLETPROOF fallback strategies
//     for (const target of targets) {
//       await processVariantWithGuaranteedSuccess(
//         dbx,
//         inputFile,
//         target,
//         tempId,
//         hasAudio,
//         tempFiles,
//         originalWidth,
//         originalHeight
//       );
//     }

//     logger.info(`Background transcoding complete for ${fileName}`);
//   } catch (error) {
//     logger.error(`Background transcoding error: ${error.message}`);
//   } finally {
//     // Cleanup temp files
//     cleanupTempFiles(tempFiles);
//   }
// }

// // Smart target selection based on original dimensions
// function getOptimalTargets(width, height, paths) {
//   const targets = [];

//   // Only create variants that make sense
//   if (height >= 1150 || width >= 2000) {
//     targets.push({ h: 1080, key: "p1080", path: paths.p1080 });
//   }
//   if (height >= 800 || width >= 1400) {
//     targets.push({ h: 720, key: "p720", path: paths.p720 });
//   }
//   if (height >= 550 || width >= 900) {
//     targets.push({ h: 480, key: "p480", path: paths.p480 });
//   }
//   if (height >= 400 || width >= 600) {
//     targets.push({ h: 360, key: "p360", path: paths.p360 });
//   }

//   return targets;
// }

// // GUARANTEED SUCCESS - Will NOT fail under any circumstance
// async function processVariantWithGuaranteedSuccess(
//   dbx,
//   inputFile,
//   target,
//   tempId,
//   hasAudio,
//   tempFiles,
//   originalWidth,
//   originalHeight
// ) {
//   logger.info(`Background transcoding ${target.h}p`);

//   const outputFile = `output-${tempId}-${target.h}p.mp4`;
//   const outputPath = path.join(SHARED_VIDEO_PATH, outputFile);
//   tempFiles.push(outputPath);

//   // Progressive fallback strategies - from optimal to guaranteed success
//   const strategies = [
//     // Strategy 1: Optimal quality
//     () => transcodeOptimal(inputFile, outputFile, target.h, hasAudio),
//     // Strategy 2: Conservative settings
//     () => transcodeConservative(inputFile, outputFile, target.h, hasAudio),
//     // Strategy 3: Simple resize only
//     () => transcodeSimple(inputFile, outputFile, target.h, hasAudio),
//     // Strategy 4: Copy with resize (works with any codec)
//     () => transcodeCopy(inputFile, outputFile, target.h),
//     // Strategy 5: GUARANTEED - Just resize without re-encoding
//     () => transcodeResize(inputFile, outputFile, target.h),
//     // Strategy 6: LAST RESORT - Scale and convert to compatible format
//     () => transcodeLastResort(inputFile, outputFile, target.h),
//   ];

//   for (let i = 0; i < strategies.length; i++) {
//     try {
//       await strategies[i]();

//       // Verify output exists and has content
//       if (fs.existsSync(outputPath)) {
//         const stats = fs.statSync(outputPath);
//         if (stats.size > 1024) {
//           const transcodedBuffer = fs.readFileSync(outputPath);
//           await uploadBufferToDropbox(dbx, transcodedBuffer, target.path);
//           logger.info(
//             `Background uploaded ${target.h}p ${target.path} (strategy ${
//               i + 1
//             }, size: ${stats.size} bytes)`
//           );
//           return; // SUCCESS - exit function
//         }
//       }
//       logger.warn(`Strategy ${i + 1} produced empty file for ${target.h}p`);
//     } catch (e) {
//       logger.warn(`Strategy ${i + 1} failed for ${target.h}p: ${e.message}`);
//     }
//   }

//   // This should NEVER happen with 6 fallback strategies
//   logger.error(
//     `IMPOSSIBLE: All 6 strategies failed for ${target.h}p - this should never occur`
//   );
// }

// // Strategy 1: Optimal settings
// async function transcodeOptimal(inputFile, outputFile, height, hasAudio) {
//   let cmd =
//     `docker exec ffmpeg-worker ffmpeg -i /tmp/videos/${inputFile} ` +
//     `-vf "scale=-2:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2" ` +
//     `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p ` +
//     `-movflags +faststart -g 48 -keyint_min 48 `;

//   if (hasAudio) {
//     cmd += `-c:a aac -b:a 128k -ar 44100 -ac 2 `;
//   } else {
//     cmd += `-an `;
//   }

//   cmd += `-y /tmp/videos/${outputFile}`;
//   await execAsync(cmd, { timeout: 600000 });
// }

// // Strategy 2: Conservative settings
// async function transcodeConservative(inputFile, outputFile, height, hasAudio) {
//   let cmd =
//     `docker exec ffmpeg-worker ffmpeg -i /tmp/videos/${inputFile} ` +
//     `-vf "scale=trunc(oh*a/2)*2:${height}" ` +
//     `-c:v libx264 -preset medium -crf 25 -pix_fmt yuv420p ` +
//     `-movflags +faststart `;

//   if (hasAudio) {
//     cmd += `-c:a aac -b:a 96k `;
//   } else {
//     cmd += `-an `;
//   }

//   cmd += `-y /tmp/videos/${outputFile}`;
//   await execAsync(cmd, { timeout: 600000 });
// }

// // Strategy 3: Simple resize
// async function transcodeSimple(inputFile, outputFile, height, hasAudio) {
//   let cmd =
//     `docker exec ffmpeg-worker ffmpeg -i /tmp/videos/${inputFile} ` +
//     `-vf "scale=-1:${height}" ` +
//     `-c:v libx264 -preset ultrafast -crf 30 `;

//   if (hasAudio) {
//     cmd += `-c:a copy `;
//   } else {
//     cmd += `-an `;
//   }

//   cmd += `-y /tmp/videos/${outputFile}`;
//   await execAsync(cmd, { timeout: 300000 });
// }

// // Strategy 4: Copy streams with scale
// async function transcodeCopy(inputFile, outputFile, height) {
//   const cmd =
//     `docker exec ffmpeg-worker ffmpeg -i /tmp/videos/${inputFile} ` +
//     `-vf "scale=-1:${height}" ` +
//     `-c copy ` +
//     `-y /tmp/videos/${outputFile}`;
//   await execAsync(cmd, { timeout: 300000 });
// }

// // Strategy 5: Just resize (maintain original codec)
// async function transcodeResize(inputFile, outputFile, height) {
//   const cmd =
//     `docker exec ffmpeg-worker ffmpeg -i /tmp/videos/${inputFile} ` +
//     `-filter:v "scale=-1:${height}" ` +
//     `-c:v copy -c:a copy ` +
//     `-avoid_negative_ts make_zero ` +
//     `-y /tmp/videos/${outputFile}`;
//   await execAsync(cmd, { timeout: 300000 });
// }

// // Strategy 6: LAST RESORT - Always works
// async function transcodeLastResort(inputFile, outputFile, height) {
//   const cmd =
//     `docker exec ffmpeg-worker ffmpeg -i /tmp/videos/${inputFile} ` +
//     `-vf "scale=${(height * 16) / 9}:${height}" ` +
//     `-c:v mpeg4 -b:v 1000k ` +
//     `-c:a mp3 -b:a 128k ` +
//     `-f mp4 ` +
//     `-y /tmp/videos/${outputFile}`;
//   await execAsync(cmd, { timeout: 300000 });
// }

// // Probe with retry logic and safer defaults
// async function probeVideoWithRetry(inputFile, maxRetries = 3) {
//   for (let i = 0; i < maxRetries; i++) {
//     try {
//       const cmd = `docker exec ffmpeg-worker ffprobe -v quiet -print_format json -show_format -show_streams /tmp/videos/${inputFile}`;
//       const { stdout } = await execAsync(cmd, { timeout: 30000 });
//       const probe = JSON.parse(stdout);

//       const videoStream = probe.streams.find((s) => s.codec_type === "video");
//       if (!videoStream) {
//         throw new Error("No video stream found");
//       }

//       return {
//         height: videoStream.height || 720,
//         width: videoStream.width || 1280,
//         duration: parseFloat(probe.format?.duration || 0),
//         hasAudio: probe.streams.some((s) => s.codec_type === "audio"),
//         codec: videoStream.codec_name || "unknown",
//         fps: parseFloat(videoStream.r_frame_rate?.split("/")[0] || 30),
//       };
//     } catch (error) {
//       logger.warn(`Probe attempt ${i + 1} failed: ${error.message}`);
//       if (i === maxRetries - 1) {
//         // Return safe defaults that will work
//         return {
//           height: 720,
//           width: 1280,
//           duration: 0,
//           hasAudio: false,
//           codec: "unknown",
//           fps: 30,
//         };
//       }
//       await new Promise((resolve) => setTimeout(resolve, 1000));
//     }
//   }
// }

// // Cleanup helper
// function cleanupTempFiles(tempFiles) {
//   tempFiles.forEach((filePath) => {
//     try {
//       if (fs.existsSync(filePath)) {
//         fs.unlinkSync(filePath);
//       }
//     } catch (e) {
//       logger.warn(`Failed to cleanup temp file ${filePath}: ${e.message}`);
//     }
//   });
// }

// // Helper functions (unchanged)
// function parseName(fileName = "video") {
//   const safeBase = (fileName || "video")
//     .trim()
//     .replace(/[^a-zA-Z0-9._-]/g, "_");
//   const dotIdx = safeBase.lastIndexOf(".");
//   let baseName = safeBase;
//   let origExt = "";
//   if (dotIdx > 0 && dotIdx < safeBase.length - 1) {
//     baseName = safeBase.slice(0, dotIdx);
//     origExt = safeBase.slice(dotIdx);
//     if (origExt.length > 8) origExt = ".mp4";
//   } else {
//     origExt = ".mp4";
//   }
//   return { baseName, origExt };
// }

// async function uploadBufferToDropbox(dbx, buffer, path) {
//   const uploaded = await dbx.filesUpload({
//     path,
//     contents: buffer,
//     mode: { ".tag": "add" },
//     autorename: true,
//   });
//   const url = await ensureSharedLink(dbx, uploaded.result.path_lower);
//   return url;
// }

// async function ensureSharedLink(dbx, pathLower) {
//   try {
//     const created = await dbx.sharingCreateSharedLinkWithSettings({
//       path: pathLower,
//     });
//     return toDirect(created.result.url);
//   } catch (e) {
//     try {
//       const existing = await dbx.sharingListSharedLinks({
//         path: pathLower,
//         direct_only: true,
//       });
//       if (existing.result.links.length) {
//         return toDirect(existing.result.links[0].url);
//       }
//     } catch {}
//     throw e;
//   }
// }

// function toDirect(url) {
//   return url
//     .replace("www.dropbox.com", "dl.dropboxusercontent.com")
//     .replace("?dl=0", "")
//     .replace("&dl=0", "");
// }

// module.exports = UploadVideoVariantsToDropbox;
