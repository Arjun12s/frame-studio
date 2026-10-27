# Frame Studio

Frame Studio turns a selected moment from a long video into a vertical short. It runs locally on Windows and saves an MP4 to your Downloads folder.

## What it does

- Accepts a public YouTube video link or a local video file.
- Reads YouTube video details first, then fetches only the selected section when you render.
- Lets you choose the clip start and adjust the center crop.
- Renders up to 60 seconds in 1080 × 1920 (9:16), with the original audio.
- Uses FFmpeg locally. Source and render files stay on your computer.

Use only videos you own or have permission to edit. Audience-retention analytics and Google sign-in are not included.

## Run on Windows

### Requirements

- Python 3.11 or newer
- Internet access for the first dependency install and for YouTube links
- PowerShell

### Start

1. Open PowerShell in the project folder.
2. Run:

   ```powershell
   .\run.ps1
   ```

3. The first run creates a `.venv` folder and installs the dependencies. The app then opens at [http://127.0.0.1:8000](http://127.0.0.1:8000).

Leave the server running while you use the app. To stop it, close the `python.exe` process listening on port 8000, or restart your computer.

### Start manually

If dependencies are already installed:

```powershell
python server.py
```

Then open [http://127.0.0.1:8000](http://127.0.0.1:8000).

## Create a Short

1. Paste a YouTube link or choose a local video file.
2. Choose the start time and adjust zoom.
3. Select **Create my Short**. The app fetches the selected YouTube section (or uses the local file), renders the MP4, and starts the download.

The first run installs `yt-dlp[default]` and `imageio-ffmpeg` in the local virtual environment. Requirements are listed in [`requirements.txt`](requirements.txt).

## Troubleshooting

- If YouTube cannot load a link, try again after updating dependencies with `python -m pip install -U -r requirements.txt` inside `.venv`.
- Keep the app tab open until rendering finishes.
- Render and temporary source files are stored in `renders/`; remove that folder when you want to reclaim disk space.
