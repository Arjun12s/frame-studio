from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import subprocess
import threading
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
MEDIA_ROOT = ROOT / "youtube_sources"
MEDIA_ROOT.mkdir(exist_ok=True)
RENDER_ROOT = ROOT / "renders"
RENDER_ROOT.mkdir(exist_ok=True)
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
MAX_SOURCE_BYTES = 3 * 1024 * 1024 * 1024


def valid_youtube_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
        host = (parsed.hostname or "").lower().rstrip(".")
        is_youtube = host == "youtu.be" or host == "youtube.com" or host.endswith(".youtube.com")
        return parsed.scheme == "https" and is_youtube and bool(parsed.path.strip("/"))
    except ValueError:
        return False


def job_update(job_id: str, **values) -> None:
    with JOBS_LOCK:
        if job_id in JOBS:
            JOBS[job_id].update(values)


def inspect_youtube(job_id: str, url: str) -> None:
    try:
        import imageio_ffmpeg
        import yt_dlp

        ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()
        node_path = shutil.which("node")
        options = {
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "ffmpeg_location": ffmpeg_path,
            "remote_components": {"ejs:github"},
        }
        if node_path:
            options["js_runtimes"] = {"node": {"path": node_path}}

        job_update(job_id, phase="extracting", percent=0, status_text="Reading YouTube video…")
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=False)
        job_update(job_id,
                   status="complete", phase="ready", percent=100,
                   status_text="Video info is ready. Choose your clip start.",
                   title=info.get("title") or "YouTube video", thumbnail=info.get("thumbnail"),
                   duration=info.get("duration") or 0, url=url)
    except Exception as exc:
        message = str(exc).strip() or "YouTube could not provide this video."
        job_update(job_id, status="error", phase="error", error=message[:350], status_text="Could not load this video.")


def render_video(job_id: str, source_path: Path, start: float, duration: float, zoom: float,
                 progress_start: int = 2) -> None:
    try:
        import imageio_ffmpeg

        output_path = RENDER_ROOT / job_id / "short.mp4"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        if zoom <= 1.0001:
            crop = "crop=w='trunc(ih*0.5625/2)*2':h='trunc(ih/2)*2':x='(iw-ow)/2':y='(ih-oh)/2'"
            tall_crop = "crop=w='trunc(iw/2)*2':h='trunc(iw/0.5625/2)*2':x='(iw-ow)/2':y='(ih-oh)/2'"
        else:
            crop = f"crop=w='trunc(ih*0.5625/{zoom}/2)*2':h='trunc(ih/2)*2':x='(iw-ow)/2':y='(ih-oh)/2'"
            tall_crop = f"crop=w='trunc(iw/2)*2':h='trunc(ih/0.5625/{zoom}/2)*2':x='(iw-ow)/2':y='(ih-oh)/2'"
        # FFmpeg chooses the applicable center-crop expression from the source aspect ratio.
        video_filter = (
            f"crop=if(gte(iw/ih\\,0.5625)\\,"
            f"trunc(ih*0.5625/{zoom}/2)*2\\,trunc(iw/2)*2):"
            f"if(gte(iw/ih\\,0.5625)\\,trunc(ih/2)*2\\,trunc(iw/0.5625/{zoom}/2)*2):"
            f"(iw-ow)/2:(ih-oh)/2,"
            "scale=w='if(gte(ih,1920),trunc(ih*0.5625/2)*2,1080)':"
            "h='if(gte(ih,1920),trunc(ih/2)*2,1920)':flags=lanczos"
        )
        # Keep the expressions assigned above available as a simple fallback if an FFmpeg
        # build rejects conditional crop syntax.
        del crop, tall_crop
        command = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-ss", f"{start:.3f}", "-i", str(source_path), "-t", f"{duration:.3f}",
            "-vf", video_filter, "-fps_mode", "passthrough", "-c:v", "libx264", "-preset", "slow",
            "-crf", "17", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", str(output_path),
        ]
        job_update(job_id, phase="rendering", percent=progress_start, status_text="High-quality encoding with FFmpeg…")
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   text=True, encoding="utf-8", errors="replace", bufsize=1)
        assert process.stdout is not None
        for line in process.stdout:
            if line.startswith("out_time_ms="):
                try:
                    encoded_seconds = int(line.partition("=")[2]) / 1_000_000
                    progress_span = 98 - progress_start
                    percent = min(98, max(progress_start, int(encoded_seconds * progress_span / duration) + progress_start))
                    job_update(job_id, percent=percent)
                except ValueError:
                    pass
        return_code = process.wait()
        if return_code != 0 or not output_path.exists() or output_path.stat().st_size == 0:
            raise RuntimeError("FFmpeg could not encode this source. Try a different video file.")
        job_update(job_id, status="complete", phase="complete", percent=100,
                   status_text="Short is ready.", filename=output_path.name,
                   size=output_path.stat().st_size, duration=duration)
    except Exception as exc:
        job_update(job_id, status="error", phase="error", error=str(exc)[:350],
                   status_text="Could not render this video.")


def render_youtube_video(job_id: str, url: str, start: float, duration: float, zoom: float) -> None:
    try:
        import imageio_ffmpeg
        import yt_dlp

        source_dir = RENDER_ROOT / job_id / "source"
        source_dir.mkdir(parents=True, exist_ok=True)
        ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()

        def progress_hook(data: dict) -> None:
            if data.get("status") == "downloading":
                total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
                downloaded = data.get("downloaded_bytes") or 0
                percent = min(38, int(downloaded * 38 / total)) if total else 8
                job_update(job_id, phase="downloading", percent=percent,
                           status_text="Fetching just the selected clip…")
            elif data.get("status") == "finished":
                job_update(job_id, phase="preparing", percent=40,
                           status_text="Preparing selected clip for render…")

        options = {
            "format": "bestvideo+bestaudio/best",
            "outtmpl": str(source_dir / "clip.%(ext)s"),
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "merge_output_format": "mp4",
            "ffmpeg_location": ffmpeg_path,
            "download_sections": [f"*{start:.3f}-{start + duration:.3f}"],
            "force_keyframes_at_cuts": True,
            "progress_hooks": [progress_hook],
            "remote_components": {"ejs:github"},
        }
        node_path = shutil.which("node")
        if node_path:
            options["js_runtimes"] = {"node": {"path": node_path}}
        job_update(job_id, phase="downloading", percent=2,
                   status_text="Fetching just the selected clip…")
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
            source_path = Path(ydl.prepare_filename(info))
            if not source_path.exists():
                candidates = list(source_dir.glob("clip.*"))
                if not candidates:
                    raise RuntimeError("The selected video section could not be downloaded.")
                source_path = candidates[0]
        job_update(job_id, phase="rendering", percent=40,
                   status_text="High-quality encoding with FFmpeg…")
        render_video(job_id, source_path, 0, duration, zoom, progress_start=40)
    except Exception as exc:
        job_update(job_id, status="error", phase="error", error=str(exc)[:350],
                   status_text="Could not render this video.")


def queue_render(source_path: Path, start: float, duration: float, zoom: float) -> str:
    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {"status": "running", "phase": "queued", "percent": 0,
                        "status_text": "Preparing fast render…"}
    worker = threading.Thread(target=render_video, args=(job_id, source_path, start, duration, zoom), daemon=True)
    worker.start()
    return job_id


def queue_youtube_render(url: str, start: float, duration: float, zoom: float) -> str:
    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {"status": "running", "phase": "queued", "percent": 0,
                        "status_text": "Preparing selected YouTube clip…"}
    worker = threading.Thread(target=render_youtube_video, args=(job_id, url, start, duration, zoom), daemon=True)
    worker.start()
    return job_id


class FrameHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        # Keep the local server console quiet while retaining access logs nowhere.
        return

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path == "/api/render":
            self.start_render()
            return
        if self.path != "/api/youtube":
            self.send_json({"error": "Not found."}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 16_384:
                self.send_json({"error": "Paste one YouTube video link."}, 400)
                return
            payload = json.loads(self.rfile.read(length))
            url = str(payload.get("url", "")).strip()
            if not valid_youtube_url(url):
                self.send_json({"error": "Paste a valid YouTube video link starting with https://."}, 400)
                return

            job_id = uuid.uuid4().hex
            with JOBS_LOCK:
                JOBS[job_id] = {"status": "running", "phase": "queued", "percent": 0,
                                "status_text": "Starting download…"}
            worker = threading.Thread(target=inspect_youtube, args=(job_id, url), daemon=True)
            worker.start()
            self.send_json({"jobId": job_id})
        except (ValueError, json.JSONDecodeError):
            self.send_json({"error": "The request could not be read."}, 400)

    def start_render(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            content_type = self.headers.get("Content-Type", "")
            if content_type.startswith("application/json"):
                if length < 1 or length > 16_384:
                    self.send_json({"error": "The render request could not be read."}, 400)
                    return
                payload = json.loads(self.rfile.read(length))
                source_id = str(payload.get("sourceJobId", ""))
                with JOBS_LOCK:
                    source_job = JOBS.get(source_id)
                if not source_job or source_job.get("status") != "complete":
                    self.send_json({"error": "Load the YouTube video again before rendering."}, 400)
                    return
                duration_total = float(source_job.get("duration") or 0)
                start = float(payload.get("start", 0))
                zoom = float(payload.get("zoom", 1))
            elif content_type.startswith("video/") or content_type == "application/octet-stream":
                if length < 1 or length > MAX_SOURCE_BYTES:
                    self.send_json({"error": "This video is empty or larger than the 3 GB upload limit."}, 413)
                    return
                try:
                    start = float(self.headers.get("X-Clip-Start", "0"))
                    duration_total = float(self.headers.get("X-Source-Duration", "0"))
                    zoom = float(self.headers.get("X-Clip-Zoom", "1"))
                except ValueError:
                    self.send_json({"error": "Invalid clip settings."}, 400)
                    return
                filename = unquote(self.headers.get("X-File-Name", "source.mp4"))
                extension = Path(filename).suffix.lower()
                if extension not in {".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi"}:
                    extension = ".mp4"
                upload_id = uuid.uuid4().hex
                upload_dir = RENDER_ROOT / upload_id
                upload_dir.mkdir(parents=True, exist_ok=True)
                source_path = upload_dir / f"source{extension}"
                with source_path.open("wb") as target:
                    remaining = length
                    while remaining:
                        block = self.rfile.read(min(1024 * 1024, remaining))
                        if not block:
                            raise ConnectionError("The video upload ended unexpectedly.")
                        target.write(block)
                        remaining -= len(block)
            else:
                self.send_json({"error": "Upload a video file or load a YouTube link first."}, 415)
                return

            if content_type.startswith("application/json"):
                if not source_job.get("url"):
                    self.send_json({"error": "Paste the YouTube link again before rendering."}, 400)
                    return
            elif not source_path.is_file():
                self.send_json({"error": "The source video could not be found."}, 404)
                return
            if not (0 <= start < max(duration_total, 1)) or not (1 <= zoom <= 1.8):
                self.send_json({"error": "Clip start or zoom is outside the allowed range."}, 400)
                return
            duration = min(60, duration_total - start)
            if duration <= 0:
                self.send_json({"error": "There is no video remaining at that start time."}, 400)
                return
            if content_type.startswith("application/json"):
                render_id = queue_youtube_render(source_job["url"], start, duration, zoom)
            else:
                render_id = queue_render(source_path, start, duration, zoom)
            self.send_json({"jobId": render_id})
        except (ValueError, json.JSONDecodeError):
            self.send_json({"error": "Invalid render request."}, 400)
        except (ConnectionError, OSError) as exc:
            self.send_json({"error": str(exc)[:250]}, 400)

    def do_GET(self):
        if self.path.startswith("/api/render-jobs/"):
            job_id = self.path.removeprefix("/api/render-jobs/").split("?", 1)[0]
            if not re.fullmatch(r"[a-f0-9]{32}", job_id):
                self.send_json({"error": "Render job not found."}, 404)
                return
            with JOBS_LOCK:
                job = JOBS.get(job_id)
            self.send_json(job or {"error": "Render job not found."}, 200 if job else 404)
            return
        if self.path.startswith("/media/render/"):
            job_id = self.path.removeprefix("/media/render/").split("?", 1)[0]
            if not re.fullmatch(r"[a-f0-9]{32}", job_id):
                self.send_error(404)
                return
            with JOBS_LOCK:
                job = JOBS.get(job_id)
            file_path = RENDER_ROOT / job_id / (job or {}).get("filename", "")
            if not job or job.get("status") != "complete" or not file_path.is_file():
                self.send_error(404)
                return
            self.serve_media(file_path)
            return
        if self.path.startswith("/api/jobs/"):
            job_id = self.path.removeprefix("/api/jobs/").split("?", 1)[0]
            if not re.fullmatch(r"[a-f0-9]{32}", job_id):
                self.send_json({"error": "Job not found."}, 404)
                return
            with JOBS_LOCK:
                job = JOBS.get(job_id)
            self.send_json(job or {"error": "Job not found."}, 200 if job else 404)
            return
        if self.path.startswith("/media/"):
            job_id = self.path.removeprefix("/media/").split("?", 1)[0]
            if not re.fullmatch(r"[a-f0-9]{32}", job_id):
                self.send_error(404)
                return
            with JOBS_LOCK:
                job = JOBS.get(job_id)
            file_path = MEDIA_ROOT / job_id / (job or {}).get("filename", "")
            if not job or job.get("status") != "complete" or not file_path.is_file():
                self.send_error(404)
                return
            self.serve_media(file_path)
            return
        return super().do_GET()

    def serve_media(self, file_path: Path) -> None:
        size = file_path.stat().st_size
        content_type = mimetypes.guess_type(file_path.name)[0] or "video/mp4"
        range_header = self.headers.get("Range", "")
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
        if match:
            start = int(match.group(1) or 0)
            end = int(match.group(2) or size - 1)
            if start >= size or end < start:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            end = min(end, size - 1)
            length = end - start + 1
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            start, length = 0, size
            self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            with file_path.open("rb") as media:
                media.seek(start)
                remaining = length
                while remaining:
                    block = media.read(min(1024 * 1024, remaining))
                    if not block:
                        break
                    self.wfile.write(block)
                    remaining -= len(block)
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8000), FrameHandler)
    print("Frame Studio is running at http://127.0.0.1:8000")
    server.serve_forever()
