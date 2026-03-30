# ZenStream Offline Encoder Documentation

The ZenStream Offline Encoder is a Node.js-based tool designed to convert diverse media formats into high-quality, streamable HLS (HTTP Live Streaming) packages. It simplifies the complexity of video transcoding, audio downmixing, and subtitle extraction.

## 1. System Architecture

The encoder is built on a modular "Analyze -> Plan -> Process" pipeline:

1.  **Analyze**: Uses `ffprobe` to identify every stream (Video, Audio, Subtitle) and their specific properties (Duration, Codec, Channels, Language).
2.  **Plan**: Generates a `video_manifest.json` following the ZenStream schema and assigns unique UUIDs to every stream.
3.  **Process**: Executes FFmpeg commands sequentially to generate HLS segments (`.ts`) and playlists (`.m3u8`).

## 2. Stream Processing Logic

### Video Transcoding
- **Codec**: Transcoded to `libx264` (H.264) for maximum compatibility.
- **Segmentation**: Chunks are split every 10 seconds.
- **Naming**: Chunks use a flat naming convention (e.g., `video_chunk_001.ts`) to avoid complex directory resolution issues in browsers.

### Audio Normalization
- **Stereo Downmixing**: All multi-channel audio (5.1, 7.1) is automatically downmixed to 2-channel stereo using `-ac 2`.
- **Silent Injection**: If a video has no audio, a silent LC-AAC stereo track is generated using `anullsrc` to prevent playback issues on devices that expect an audio track.
- **Multi-Track Support**: Every audio track in the source file is extracted into its own HLS stream, allowing users to switch languages in the player.

### Subtitle Extraction
- **Format**: All internal subtitle tracks (SRT, ASS, PGS) are converted to WebVTT (`.vtt`) for native browser support.

## 3. Manifest Schema

The generated `video_manifest.json` provides a single entry point for client applications:

```json
{
  "movie_title": "Example Movie",
  "movie_id": "12345",
  "num_streams_a": 2, // Audio tracks count
  "num_streams_v": 1, // Video tracks count
  "num_streams_s": 1, // Subtitle tracks count
  "streams": [
    {
      "streamType": "video",
      "streamId": "uuid-v4",
      "codec": "h264",
      "resolution": "1920x1080",
      "playlist": "master.m3u8"
    },
    ...
  ]
}
```

## 4. Usage Instructions

### Prerequisites
- Node.js installed on your system.
- No FFmpeg installation is required (the system uses `ffmpeg-static` internal binaries).

### Encoding a Movie
Run the script with the input path and a TMDB ID:

```powershell
node index.js "C:\Path\To\Your\Movie.mkv" <TMDB_ID>
```

### Output Structure
The output is generated in `./<TMDB_ID>/hls_output/`:
- `master.m3u8`: The main playlist entry point.
- `video_manifest.json`: The technical manifest for the app.
- `video_stream.m3u8` / `audio_stream_N.m3u8`: Variant playlists.
- `*.ts`: Media segments stored in a flat layout for high reliability.

## 5. Browser Testing
A local test player `test_player.html` is provided. To test your output:
1. Start a local server: `npx http-server -p 8888 --cors -c-1`
2. Open `http://localhost:8888/test_player.html`
3. Enter your TMDB ID and click **Load Stream**.