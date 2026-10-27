const $ = (selector) => document.querySelector(selector);

const fileInput = $('#file-input');
const dropzone = $('#dropzone');
const video = $('#source-video');
const canvas = $('#preview-canvas');
const context = canvas.getContext('2d', { alpha: false });
const startRange = $('#start-range');
const startInput = $('#start-input');
const zoomRange = $('#zoom-range');
const createButton = $('#create-button');
const previewButton = $('#play-button');
const MAX_SHORT_SECONDS = 60;
const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;

let sourceFile = null;
let sourceUrl = null;
let sourceUrlIsObject = false;
let sourceKind = 'local';
let sourceJobId = null;
let sourceDuration = 0;
let outputUrl = null;
let outputUrlIsObject = false;
let renderAnimation = 0;
let frameAnimation = 0;
let zoom = 1;
let audioContext = null;
let audioSource = null;
let audioDestination = null;
let busy = false;
let downloadBusy = false;

canvas.width = OUTPUT_WIDTH;
canvas.height = OUTPUT_HEIGHT;

function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function clipLength() {
  return Math.min(MAX_SHORT_SECONDS, sourceDuration || video.duration || MAX_SHORT_SECONDS);
}

function selectedStart() {
  return Math.min(Number(startRange.value) || 0, Number(startRange.max) || 0);
}

function drawFrame() {
  if (!video.videoWidth || !video.videoHeight) return;
  const targetRatio = OUTPUT_WIDTH / OUTPUT_HEIGHT;
  const sourceRatio = video.videoWidth / video.videoHeight;
  let sourceWidth;
  let sourceHeight;

  if (sourceRatio > targetRatio) {
    sourceHeight = video.videoHeight / zoom;
    sourceWidth = sourceHeight * targetRatio;
  } else {
    sourceWidth = video.videoWidth / zoom;
    sourceHeight = sourceWidth / targetRatio;
  }

  const sourceX = (video.videoWidth - sourceWidth) / 2;
  const sourceY = (video.videoHeight - sourceHeight) / 2;
  context.fillStyle = '#10100f';
  context.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
  context.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
}

function animatePreview() {
  drawFrame();
  if (!video.paused && !video.ended) frameAnimation = requestAnimationFrame(animatePreview);
}

function updateStart(value) {
  const max = Number(startRange.max) || 0;
  const start = Math.max(0, Math.min(Number(value) || 0, max));
  startRange.value = String(start);
  startInput.value = String(Math.floor(start));
  $('#current-time').textContent = formatTime(start);
  const duration = sourceDuration || video.duration || 0;
  const width = duration ? Math.min(100, (clipLength() / duration) * 100) : 17;
  const left = duration ? (start / duration) * 100 : 0;
  $('#range-fill').style.width = `${width}%`;
  $('#range-fill').style.marginLeft = `${left}%`;
  if (sourceKind === 'local' && video.readyState >= 2 && video.paused) {
    video.currentTime = start;
    drawFrame();
  }
}

function setReadyState() {
  const locked = busy || downloadBusy;
  const hasDuration = sourceKind === 'youtube' ? sourceDuration > 0 : video.readyState >= 1;
  const ready = Boolean(sourceFile && hasDuration && !locked);
  fileInput.disabled = locked;
  $('#remove-file').disabled = locked;
  $('#youtube-url').disabled = locked;
  $('#youtube-submit').disabled = locked;
  dropzone.style.pointerEvents = locked ? 'none' : '';
  dropzone.style.opacity = locked ? '.5' : '';
  createButton.disabled = !ready;
  startRange.disabled = !ready;
  startInput.disabled = !ready;
  zoomRange.disabled = !ready;
  $('#reset-zoom').disabled = !ready;
  previewButton.hidden = !ready || sourceKind === 'youtube';
  $('#preview-overlay').hidden = !ready;
}

function clearResult() {
  $('#progress-panel').hidden = true;
  $('#result-panel').hidden = true;
  if (outputUrlIsObject && outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = null;
  outputUrlIsObject = false;
}

function attachVideo(source, mediaUrl, isObjectUrl, kind = 'local', jobId = null) {
  if (sourceUrlIsObject && sourceUrl) URL.revokeObjectURL(sourceUrl);
  clearResult();
  sourceFile = source;
  sourceUrl = mediaUrl;
  sourceUrlIsObject = isObjectUrl;
  sourceKind = kind;
  sourceJobId = jobId;
  sourceDuration = 0;
  video.pause();
  video.src = mediaUrl;
  video.load();
  $('#drop-title').textContent = 'Drop another video here';
  $('#drop-subtitle').innerHTML = 'or <b>browse files</b> from your device';
  $('#file-meta').hidden = false;
  $('#preview-canvas').hidden = false;
  $('#preview-poster').hidden = true;
  $('#preview-poster').src = '';
  $('#preview-empty').hidden = true;
  $('#file-name').textContent = source.name;
  $('#file-info').textContent = `${formatSize(source.size)} · loading video…`;
  $('#preview-empty').hidden = true;
  $('#preview-label').textContent = 'LOADING VIDEO';
  $('#preview-status').classList.remove('ready');
  $('#source-duration').textContent = '00:00';
  $('#current-time').textContent = '00:00';
  $('#range-fill').style.width = '17%';
  $('#range-fill').style.marginLeft = '0';
  startRange.max = '0';
  startRange.value = '0';
  startInput.value = '0';
  zoom = 1;
  zoomRange.value = '1';
  $('#zoom-value').textContent = '1.0×';
  setReadyState();
}

function loadFile(file) {
  if (!file || !file.type.startsWith('video/')) {
    $('#drop-title').textContent = 'That file does not look like a video';
    $('#drop-subtitle').textContent = 'Choose an MP4, MOV, or WEBM video instead';
    return;
  }
  attachVideo(file, URL.createObjectURL(file), true);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function loadYoutubeVideo(url) {
  const hint = $('#source-hint');
  const submit = $('#youtube-submit');
  const status = $('#download-status');
  hint.classList.remove('error');
  hint.textContent = 'Use a video you own or have permission to edit.';
  downloadBusy = true;
  setReadyState();
  status.hidden = false;
  $('#download-progress-bar').style.width = '0%';
  $('#download-percent').textContent = '0%';
  $('#download-label').textContent = 'Reading YouTube video…';
  $('#download-hint').textContent = 'Reading video details first. The selected clip downloads when you render.';
  submit.textContent = 'Loading…';
  try {
    const response = await fetch('/api/youtube', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
    });
    const started = await response.json();
    if (!response.ok) throw new Error(started.error || 'Could not start the download.');
    const jobId = started.jobId;
    while (true) {
      await sleep(900);
      const jobResponse = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' });
      const job = await jobResponse.json();
      if (!jobResponse.ok) throw new Error(job.error || 'The download status was lost.');
      const percent = Number(job.percent) || 0;
      $('#download-progress-bar').style.width = `${percent}%`;
      $('#download-percent').textContent = `${percent}%`;
      $('#download-label').textContent = job.status_text || 'Downloading video…';
      if (job.status === 'error') throw new Error(job.error || 'Could not read this YouTube video.');
      if (job.status === 'complete') {
        loadYoutubeMetadata(jobId, job);
        $('#youtube-url').value = '';
        status.hidden = true;
        return;
      }
    }
  } catch (error) {
    hint.classList.add('error');
    hint.textContent = error?.message || 'Could not load that link. Try a public YouTube video.';
    $('#download-label').textContent = 'Could not load this video';
    $('#download-hint').textContent = 'Check the link and try again.';
  } finally {
    downloadBusy = false;
    submit.innerHTML = 'Load video <span>↗</span>';
    setReadyState();
  }
}

function loadYoutubeMetadata(jobId, job) {
  const duration = Number(job.duration) || 0;
  if (!duration) throw new Error('Could not read the video duration from this link.');
  if (sourceUrlIsObject && sourceUrl) URL.revokeObjectURL(sourceUrl);
  clearResult();
  video.pause();
  video.removeAttribute('src');
  video.load();
  sourceFile = { name: `${safeFilename(job.title || 'YouTube video')}.mp4`, size: 0, type: 'video/mp4' };
  sourceUrl = null;
  sourceUrlIsObject = false;
  sourceKind = 'youtube';
  sourceJobId = jobId;
  sourceDuration = duration;
  $('#file-meta').hidden = false;
  $('#file-name').textContent = sourceFile.name;
  $('#file-info').textContent = `${formatTime(duration)} · only your selected clip will download`;
  $('#preview-canvas').hidden = true;
  $('#preview-poster').hidden = true;
  $('#preview-poster').src = '';
  $('#preview-empty').hidden = true;
  $('#preview-poster').src = job.thumbnail || '';
  $('#preview-poster').hidden = !job.thumbnail;
  $('#preview-label').textContent = 'VIDEO INFO READY';
  $('#preview-status').classList.add('ready');
  $('#preview-overlay').hidden = false;
  $('#source-duration').textContent = formatTime(duration);
  const maxStart = Math.max(0, duration - Math.min(MAX_SHORT_SECONDS, duration));
  startRange.max = String(maxStart);
  startInput.max = String(Math.floor(maxStart));
  startRange.value = '0';
  startInput.value = '0';
  $('#current-time').textContent = '00:00';
  $('#range-fill').style.width = `${duration ? Math.min(100, clipLength() / duration * 100) : 100}%`;
  $('#range-fill').style.marginLeft = '0';
  zoom = 1;
  zoomRange.value = '1';
  $('#zoom-value').textContent = '1.0×';
  setReadyState();
}

$('#youtube-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const url = $('#youtube-url').value.trim();
  if (!/^https:\/\/(?:[\w-]+\.)*youtube\.com\/|^https:\/\/youtu\.be\//i.test(url)) {
    $('#source-hint').classList.add('error');
    $('#source-hint').textContent = 'Paste a YouTube video link that starts with https://.';
    return;
  }
  loadYoutubeVideo(url);
});

video.addEventListener('loadedmetadata', () => {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  sourceDuration = duration;
  const maxStart = Math.max(0, duration - clipLength());
  startRange.max = String(maxStart);
  startRange.value = '0';
  startInput.max = String(Math.floor(maxStart));
  $('#source-duration').textContent = formatTime(duration);
  $('#file-info').textContent = `${formatSize(sourceFile.size)} · ${formatTime(duration)}`;
  $('#preview-label').textContent = 'READY TO FRAME';
  $('#preview-status').classList.add('ready');
  updateStart(0);
  setReadyState();
});

video.addEventListener('loadeddata', drawFrame);
video.addEventListener('seeked', drawFrame);
video.addEventListener('play', () => {
  previewButton.textContent = 'Ⅱ';
  previewButton.setAttribute('aria-label', 'Pause preview');
  cancelAnimationFrame(frameAnimation);
  animatePreview();
});
video.addEventListener('pause', () => {
  previewButton.textContent = '▶';
  previewButton.setAttribute('aria-label', 'Play preview');
  cancelAnimationFrame(frameAnimation);
  drawFrame();
});
video.addEventListener('ended', () => {
  if (!busy) {
    video.currentTime = selectedStart();
    previewButton.textContent = '▶';
    drawFrame();
  }
});
video.addEventListener('error', () => {
  $('#preview-label').textContent = 'UNABLE TO READ VIDEO';
  $('#file-info').textContent = 'Try a different MP4, MOV, or WEBM file.';
  createButton.disabled = true;
});

fileInput.addEventListener('change', (event) => {
  loadFile(event.target.files[0]);
  fileInput.value = '';
});
dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropzone.classList.add('dragging');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragging');
  loadFile(event.dataTransfer.files[0]);
});

$('#remove-file').addEventListener('click', () => {
  video.pause();
  video.removeAttribute('src');
  video.load();
  if (sourceUrlIsObject && sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = null;
  sourceUrlIsObject = false;
  sourceFile = null;
  sourceKind = 'local';
  sourceJobId = null;
  sourceDuration = 0;
  fileInput.value = '';
  clearResult();
  $('#file-meta').hidden = true;
  $('#preview-empty').hidden = false;
  $('#preview-canvas').hidden = true;
  $('#preview-label').textContent = 'WAITING FOR VIDEO';
  $('#preview-status').classList.remove('ready');
  $('#drop-title').textContent = 'Drop your video here';
  $('#drop-subtitle').innerHTML = 'or <b>browse files</b> from your device';
  createButton.disabled = true;
  startRange.disabled = true;
  startInput.disabled = true;
  zoomRange.disabled = true;
  $('#reset-zoom').disabled = true;
  previewButton.hidden = true;
});

startRange.addEventListener('input', () => updateStart(startRange.value));
startInput.addEventListener('change', () => updateStart(startInput.value));
zoomRange.addEventListener('input', () => {
  zoom = Number(zoomRange.value);
  $('#zoom-value').textContent = `${zoom.toFixed(1)}×`;
  drawFrame();
});
$('#reset-zoom').addEventListener('click', () => {
  zoom = 1;
  zoomRange.value = '1';
  $('#zoom-value').textContent = '1.0×';
  drawFrame();
});

previewButton.addEventListener('click', async () => {
  if (video.paused) {
    try {
      if (!audioContext) setupAudio();
      await audioContext.resume();
      audioSource.disconnect();
      audioSource.connect(audioDestination);
      audioSource.connect(audioContext.destination);
      if (video.currentTime < selectedStart() || video.currentTime >= selectedStart() + clipLength()) video.currentTime = selectedStart();
      await video.play();
      const previewEnd = selectedStart() + clipLength();
      const stopPreview = () => {
        if (!video.paused && video.currentTime >= previewEnd) video.pause();
        else if (!video.paused) requestAnimationFrame(stopPreview);
      };
      requestAnimationFrame(stopPreview);
    } catch (error) {
      showError(error);
    }
  } else {
    video.pause();
  }
});

function setupAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error('This browser does not support audio capture. Try the latest Chrome or Edge.');
  audioContext = new AudioContextClass();
  audioSource = audioContext.createMediaElementSource(video);
  audioDestination = audioContext.createMediaStreamDestination();
  audioSource.connect(audioDestination);
}

function setProgress(percent, label) {
  $('#progress-bar').style.width = `${Math.max(0, Math.min(100, percent))}%`;
  $('#progress-percent').textContent = `${Math.floor(percent)}%`;
  if (label) $('#progress-label').textContent = label;
}

function safeFilename(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim() || 'video';
}

function showError(error) {
  $('#progress-panel').hidden = true;
  $('#result-panel').hidden = false;
  $('.result-check').textContent = '!';
  $('.result-check').style.color = '#ff9b87';
  $('.result-check').style.background = '#442c27';
  $('.result-copy strong').textContent = 'Could not create the Short';
  $('#result-details').textContent = error?.message || 'Try another video or browser.';
  $('#download-again').hidden = true;
}

async function createShortWithBrowserRecorder() {
  if (!sourceFile || busy) return;
  const canvasStreamSupport = canvas.captureStream || canvas.mozCaptureStream;
  if (!canvasStreamSupport || !window.MediaRecorder) {
    showError(new Error('Video rendering is not supported in this browser. Open this app in the latest Chrome or Edge.'));
    return;
  }
  busy = true;
  setReadyState();
  clearResult();
  video.pause();
  $('#preview-canvas').hidden = false;
  $('#progress-panel').hidden = false;
  createButton.querySelector('#button-text').textContent = 'Rendering your Short…';
  createButton.querySelector('.button-note').textContent = 'Keep this tab open until the download is ready.';
  setProgress(0, 'Getting your frame ready…');

  try {
    if (!audioContext) setupAudio();
    await audioContext.resume();
    audioSource.disconnect();
    audioSource.connect(audioDestination);

    const start = selectedStart();
    const duration = Math.min(clipLength(), Math.max(0, video.duration - start));
    const end = start + duration;
    video.currentTime = start;
    await new Promise((resolve, reject) => {
      if (Math.abs(video.currentTime - start) < 0.03 && video.readyState >= 2) resolve();
      else {
        video.addEventListener('seeked', resolve, { once: true });
        video.addEventListener('error', reject, { once: true });
      }
    });
    drawFrame();

    const canvasStream = canvas.captureStream(30);
    const outputStream = new MediaStream([...canvasStream.getVideoTracks(), ...audioDestination.stream.getAudioTracks()]);
    const mimeCandidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    const mimeType = mimeCandidates.find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('This browser cannot export WebM video. Try the latest Chrome or Edge.');
    const recorder = new MediaRecorder(outputStream, { mimeType, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 160_000 });
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };

    const done = new Promise((resolve, reject) => {
      recorder.onerror = (event) => reject(event.error || new Error('The browser stopped recording unexpectedly.'));
      recorder.onstop = resolve;
    });

    recorder.start(500);
    await video.play();
    $('#preview-label').textContent = 'RENDERING YOUR SHORT';

    await new Promise((resolve, reject) => {
      let lastProgressAt = 0;
      const tick = () => {
        if (video.error) return reject(new Error('The video could not be decoded during export.'));
        drawFrame();
        const elapsed = Math.max(0, video.currentTime - start);
        const pct = duration > 0 ? Math.min(99, (elapsed / duration) * 100) : 99;
        const now = performance.now();
        if (now - lastProgressAt > 120) {
          setProgress(pct, `Rendering your Short… ${formatTime(elapsed)} / ${formatTime(duration)}`);
          lastProgressAt = now;
        }
        if (video.currentTime >= end || video.ended) {
          if (recorder.state !== 'inactive') recorder.stop();
          video.pause();
          resolve();
          return;
        }
        renderAnimation = requestAnimationFrame(tick);
      };
      renderAnimation = requestAnimationFrame(tick);
    });
    await done;
    canvasStream.getTracks().forEach((track) => track.stop());
    outputStream.getTracks().forEach((track) => track.stop());

    const blob = new Blob(chunks, { type: mimeType });
    if (!blob.size) throw new Error('The browser created an empty video. Try another source file.');
    outputUrl = URL.createObjectURL(blob);
    const download = $('#download-again');
    download.href = outputUrl;
    download.download = `${safeFilename(sourceFile.name)}-short-9x16.webm`;
    download.hidden = false;
    $('#result-panel').hidden = false;
    $('.result-check').textContent = '✓';
    $('.result-check').style.color = '';
    $('.result-check').style.background = '';
    $('.result-copy strong').textContent = 'Your Short is ready';
    $('#result-details').textContent = `${formatTime(duration)} · ${OUTPUT_WIDTH} × ${OUTPUT_HEIGHT} · ${formatSize(blob.size)}`;
    setProgress(100, 'Your Short is ready to download.');
    $('#progress-panel').hidden = true;
    download.click();
    $('#preview-label').textContent = 'SHORT READY';
  } catch (error) {
    cancelAnimationFrame(renderAnimation);
    showError(error);
  } finally {
    busy = false;
    setReadyState();
    createButton.querySelector('#button-text').textContent = 'Create my Short';
    createButton.querySelector('.button-note').textContent = '60 seconds · 9:16 vertical · saved as WebM';
    if (video.readyState >= 2) {
      video.currentTime = selectedStart();
      drawFrame();
    }
  }
}

async function createShort() {
  if (!sourceFile || busy) return;
  busy = true;
  setReadyState();
  clearResult();
  video.pause();
  $('#preview-canvas').hidden = false;
  $('#progress-panel').hidden = false;
  createButton.querySelector('#button-text').textContent = 'Rendering your Short…';
  createButton.querySelector('.button-note').textContent = 'Fast local render · MP4 download';
  setProgress(1, 'Preparing fast render…');
  $('#progress-hint').textContent = sourceKind === 'youtube'
    ? 'Only the selected section downloads, then FFmpeg renders it. Keep this tab open.'
    : 'Rendering on this computer with FFmpeg. Keep this tab open.';

  try {
    let response;
    if (sourceKind === 'youtube') {
      response = await fetch('/api/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceJobId, start: selectedStart(), zoom }),
      });
    } else {
      response = await fetch('/api/render', {
        method: 'POST',
        headers: {
          'Content-Type': sourceFile.type || 'application/octet-stream',
          'X-Clip-Start': String(selectedStart()),
          'X-Clip-Zoom': String(zoom),
          'X-Source-Duration': String(video.duration),
          'X-File-Name': encodeURIComponent(sourceFile.name),
        },
        body: sourceFile,
      });
    }
    const started = await response.json();
    if (!response.ok) throw new Error(started.error || 'Could not start the render.');
    const renderId = started.jobId;

    while (true) {
      await sleep(650);
      const statusResponse = await fetch(`/api/render-jobs/${renderId}`, { cache: 'no-store' });
      const render = await statusResponse.json();
      if (!statusResponse.ok) throw new Error(render.error || 'The render status was lost.');
      setProgress(render.percent || 0, render.status_text || 'Rendering your Short…');
      if (render.status === 'error') throw new Error(render.error || 'Could not render this video.');
      if (render.status === 'complete') {
        outputUrl = `/media/render/${renderId}`;
        outputUrlIsObject = false;
        const download = $('#download-again');
        download.href = outputUrl;
        download.download = `${safeFilename(sourceFile.name)}-short-9x16.mp4`;
        download.hidden = false;
        $('#result-panel').hidden = false;
        $('.result-check').textContent = '✓';
        $('.result-check').style.color = '';
        $('.result-check').style.background = '';
        $('.result-copy strong').textContent = 'Your Short is ready';
        $('#result-details').textContent = `${formatTime(render.duration || clipLength())} · 1080 × 1920 · ${formatSize(render.size || 0)} · MP4`;
        $('#progress-panel').hidden = true;
        download.click();
        $('#preview-label').textContent = 'SHORT READY';
        break;
      }
    }
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    setReadyState();
    createButton.querySelector('#button-text').textContent = 'Create my Short';
    createButton.querySelector('.button-note').textContent = '60 seconds · 9:16 vertical · saved as MP4';
  }
}

createButton.addEventListener('click', createShort);

window.addEventListener('beforeunload', () => {
  if (sourceUrlIsObject && sourceUrl) URL.revokeObjectURL(sourceUrl);
  if (outputUrlIsObject && outputUrl) URL.revokeObjectURL(outputUrl);
});
