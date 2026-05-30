const { spawn } = require('child_process');
const fs = require('fs');

// ─── Stream Configurations ───────────────────────────────────────────
const STREAMS = {
  minecraft: {
    playlist: 'playlists/lofi',
    background: 'backgrounds/minecraft.mp4',
    streamKeyEnv: 'STREAM_KEY_MINECRAFT',
    label: 'MINECRAFT LOFI'
  },
  chillout: {
    playlist: 'playlists/legend',
    background: 'backgrounds/rain.mp4',
    streamKeyEnv: 'STREAM_KEY_CHILLOUT',
    label: 'CHILLOUT LEGEND'
  }
};

// ─── Timing Constants ────────────────────────────────────────────────
const SESSION_DURATION_MS = (5 * 60 + 57) * 60 * 1000; // 5 hours 57 minutes
const REPO = 'stream3549/stream-lab';
const WORKFLOW_FILE = 'stream.yml';

// ─── Determine Stream Type ──────────────────────────────────────────
function getStreamType() {
  const input = (process.env.STREAM_TYPE || 'auto').toLowerCase().trim();
  if (input !== 'auto') return input;

  // Auto-detect: UTC 1-13 = minecraft (US night), UTC 13-1 = chillout (US day)
  const hour = new Date().getUTCHours();
  const type = (hour >= 1 && hour < 13) ? 'minecraft' : 'chillout';
  console.log(`[AUTO-DETECT] UTC hour ${hour} → ${type}`);
  return type;
}

// ─── State ───────────────────────────────────────────────────────────
let currentFfmpeg = null;
let streamType = '';
let streamConfig = null;
let streamKey = '';
const sessionNumber = parseInt(process.env.SESSION_NUMBER || '1', 10);

// ─── Generate Playlist File ─────────────────────────────────────────
function generatePlaylist() {
  const dir = streamConfig.playlist;
  if (!fs.existsSync(dir)) {
    console.error(`FATAL: Playlist directory not found: ${dir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.mp3') || f.endsWith('.wav'))
    .sort();

  if (files.length === 0) {
    console.error(`FATAL: No audio files in ${dir}`);
    process.exit(1);
  }

  // Unroll playlist 15 times for ~12 hours of content without stream_loop
  const basePaths = files.map(f => `file '${dir}/${f}'`).join('\n');
  const fullPlaylist = Array(15).fill(basePaths).join('\n');
  fs.writeFileSync('playlist.txt', fullPlaylist);
  console.log(`[PLAYLIST] Generated with ${files.length} tracks × 15 repeats`);
}

// ─── Start FFmpeg ───────────────────────────────────────────────────
function startFfmpeg() {
  if (currentFfmpeg) {
    console.log('[ENGINE] Killing existing FFmpeg process...');
    try { currentFfmpeg.kill('SIGKILL'); } catch (e) {}
    currentFfmpeg = null;
  }

  generatePlaylist();

  // Write song title overlay
  fs.writeFileSync('song_title.txt', `  ${streamConfig.label}  `);

  const bg = streamConfig.background;
  if (!fs.existsSync(bg)) {
    console.error(`FATAL: Background video not found: ${bg}`);
    process.exit(1);
  }

  const filterGraph = [
    '[1:v]drawtext=',
    'fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf:',
    'textfile=song_title.txt:reload=1:',
    'fontcolor=0xCCCCCC:fontsize=18:',
    'box=1:boxcolor=0x000000AA:boxborderw=12:',
    'x=(w-text_w)/2:y=h-60[v]'
  ].join('');

  const args = [
    // Audio input — read at real-time rate
    '-re',
    '-f', 'concat',
    '-safe', '0',
    '-i', 'playlist.txt',
    // Video background — loop indefinitely
    '-re',
    '-stream_loop', '-1',
    '-i', bg,
    // Filter + mapping
    '-filter_complex', filterGraph,
    '-map', '[v]',
    '-map', '0:a',
    // Video encoding
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-b:v', '4000k',
    '-maxrate', '4000k',
    '-bufsize', '8000k',
    '-pix_fmt', 'yuv420p',
    '-g', '50',
    '-keyint_min', '50',
    // Audio encoding
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    // Output
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
  ];

  console.log(`[ENGINE] Starting FFmpeg → YouTube RTMP...`);
  const proc = spawn('ffmpeg', args);
  currentFfmpeg = proc;

  proc.stderr.on('data', (data) => {
    const line = data.toString().trim();
    // Log progress frames compactly, everything else in full
    if (line.includes('frame=')) {
      process.stdout.write(`\r${line.slice(0, 120)}`);
    } else {
      console.log(`[FFmpeg] ${line}`);
    }
  });

  proc.on('close', (code) => {
    console.log(`\n[ENGINE] FFmpeg exited with code ${code}`);
    if (currentFfmpeg === proc) currentFfmpeg = null;

    // Auto-restart on unexpected crash (but not if we killed it intentionally)
    if (!proc._intentionalKill && code !== 0) {
      console.log('[ENGINE] Unexpected crash. Restarting in 10 seconds...');
      setTimeout(startFfmpeg, 10000);
    }
  });
}

// ─── Daisy-Chain: Trigger Next Runner ───────────────────────────────
async function triggerNextRunner() {
  const pat = process.env.GH_PAT;
  if (!pat) {
    console.log('[DAISY-CHAIN] No GH_PAT available. Cannot trigger next runner.');
    return;
  }

  const nextSession = sessionNumber + 1;
  console.log(`[DAISY-CHAIN] Triggering next runner (type: ${streamType}, session: ${nextSession})...`);
  try {
    const url = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${pat}`
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          stream_type: streamType,
          session_number: String(nextSession)
        }
      })
    });

    if (res.ok || res.status === 204) {
      console.log(`[DAISY-CHAIN] Next runner (Session #${nextSession}) triggered successfully!`);
    } else {
      const body = await res.text();
      console.error(`[DAISY-CHAIN] Failed (${res.status}): ${body}`);
    }
  } catch (err) {
    console.error('[DAISY-CHAIN] Error:', err.message);
  }
}

// ─── Graceful Shutdown ──────────────────────────────────────────────
async function shutdown(triggerNext) {
  console.log('\n[SHUTDOWN] Initiating graceful shutdown...');

  if (triggerNext) {
    await triggerNextRunner();
  }

  if (currentFfmpeg) {
    currentFfmpeg._intentionalKill = true;
    try { currentFfmpeg.kill('SIGKILL'); } catch (e) {}
    currentFfmpeg = null;
  }

  console.log('[SHUTDOWN] Clean exit.');
  process.exit(0);
}

// ─── Boot Sequence ──────────────────────────────────────────────────
function boot() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   STREAM LAB — Autonomous Engine v2.0   ║');
  console.log('╚══════════════════════════════════════════╝');

  // Determine stream type
  streamType = getStreamType();
  streamConfig = STREAMS[streamType];

  if (!streamConfig) {
    console.error(`FATAL: Unknown stream type "${streamType}". Valid: minecraft, chillout`);
    process.exit(1);
  }

  // Get stream key from environment
  streamKey = process.env[streamConfig.streamKeyEnv];
  if (!streamKey) {
    console.error(`FATAL: ${streamConfig.streamKeyEnv} is not set in environment.`);
    process.exit(1);
  }

  console.log(`[CONFIG] Stream Type:  ${streamType.toUpperCase()}`);
  console.log(`[CONFIG] Session Num:  #${sessionNumber}`);
  console.log(`[CONFIG] Playlist:     ${streamConfig.playlist}`);
  console.log(`[CONFIG] Background:   ${streamConfig.background}`);
  console.log(`[CONFIG] Session Time: ${Math.floor(SESSION_DURATION_MS / 60000)} minutes`);
  console.log(`[CONFIG] RTMP Target:  rtmp://a.rtmp.youtube.com/live2/****`);
  console.log('');

  // Start streaming
  startFfmpeg();

  // Schedule daisy-chain shutdown
  const shouldChain = sessionNumber < 2;
  if (shouldChain) {
    console.log(`[TIMER] Auto daisy-chain (Session #${sessionNumber + 1}) in ${Math.floor(SESSION_DURATION_MS / 60000)} minutes`);
    setTimeout(() => shutdown(true), SESSION_DURATION_MS);
  } else {
    console.log(`[TIMER] Final Session (#${sessionNumber}) reached. Stream will stop in ${Math.floor(SESSION_DURATION_MS / 60000)} minutes`);
    setTimeout(() => shutdown(false), SESSION_DURATION_MS);
  }
}

// ─── Error Handlers ─────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
  process.exit(1);
});

process.on('SIGTERM', () => shutdown(false));
process.on('SIGINT', () => shutdown(false));

// ─── Launch ─────────────────────────────────────────────────────────
boot();
