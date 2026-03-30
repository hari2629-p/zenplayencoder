const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

// Configure fluent-ffmpeg to use the static binaries
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

console.log('ZenStream Offline Encoder Initialized.');
console.log('FFmpeg Path:', ffmpegStatic);
console.log('FFprobe Path:', ffprobeStatic.path);

async function analyzeMedia(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                return reject(err);
            }
            resolve(metadata);
        });
    });
}

function buildDirectoryStructure(tmdbId, baseOutputDir = process.cwd()) {
    const tmdbDir = path.join(baseOutputDir, String(tmdbId));
    const hlsDir = path.join(tmdbDir, 'hls_output');
    
    const dirsToCreate = [
        tmdbDir,
        hlsDir,
        path.join(hlsDir, 'Subtitle_Files'),
        path.join(hlsDir, 'video_chunks')
    ];

    dirsToCreate.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });

    return hlsDir;
}

function parseStreams(metadata) {
    const streams = metadata.streams;
    const videoStreams = streams.filter(s => s.codec_type === 'video');
    const audioStreams = streams.filter(s => s.codec_type === 'audio');
    const subtitleStreams = streams.filter(s => s.codec_type === 'subtitle');

    return {
        videoStreams,
        audioStreams,
        subtitleStreams
    };
}

function generateManifest(movieTitle, tmdbId, parsedStreams, hlsDir) {
    const manifest = {
        movie_title: movieTitle,
        movie_id: tmdbId,
        num_streams_a: parsedStreams.audioStreams.length,
        num_streams_v: parsedStreams.videoStreams.length,
        num_streams_s: parsedStreams.subtitleStreams.length,
        streams: []
    };

    parsedStreams.videoStreams.forEach((vStream) => {
        manifest.streams.push({
            streamType: "video",
            streamId: uuidv4(),
            codec: vStream.codec_name,
            resolution: `${vStream.width}x${vStream.height}`,
            playlist: "master.m3u8"
        });
    });

    if (parsedStreams.audioStreams.length === 0) {
        manifest.streams.push({
            streamType: "audio",
            streamId: uuidv4(),
            streamName: "Silent Audio",
            codec: "aac",
            channels: 2,
            language: "und",
            playlist: "audio_stream_0.m3u8"
        });
    } else {
        parsedStreams.audioStreams.forEach((aStream, index) => {
            const lang = aStream.tags?.language || 'und';
            const title = aStream.tags?.title || `Audio Stream ${index + 1}`;
            manifest.streams.push({
                streamType: "audio",
                streamId: uuidv4(),
                streamName: title,
                codec: "aac",
                channels: 2,
                language: lang,
                playlist: `audio_stream_${index}.m3u8`
            });
        });
    }

    parsedStreams.subtitleStreams.forEach((sStream, index) => {
        const lang = sStream.tags?.language || 'und';
        const title = sStream.tags?.title || `Subtitle Stream ${index + 1}`;
        manifest.streams.push({
            streamType: "subtitle",
            streamId: uuidv4(),
            streamName: title,
            codec: "webvtt",
            language: lang,
            path: `Subtitle_Files/subtitle_${index}.vtt`
        });
    });

    const manifestPath = path.join(hlsDir, 'video_manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 4));
    return manifestPath;
}

function writeMasterPlaylist(parsedStreams, hlsDir) {
    let masterContent = '#EXTM3U\n#EXT-X-VERSION:3\n';
    let audioGroup = 'audio';
    
    if (parsedStreams.audioStreams.length === 0) {
       masterContent += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${audioGroup}",NAME="Silent",DEFAULT=YES,URI="audio_stream_0.m3u8"\n`;
    } else {
        parsedStreams.audioStreams.forEach((aStream, index) => {
            const lang = aStream.tags?.language || `und`;
            const name = aStream.tags?.title || `Audio ${index + 1}`;
            const isDefault = index === 0 ? 'YES' : 'NO';
            masterContent += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${audioGroup}",LANGUAGE="${lang}",NAME="${name}",DEFAULT=${isDefault},URI="audio_stream_${index}.m3u8"\n`;
        });
    }

    let subGroup = 'subs';
    parsedStreams.subtitleStreams.forEach((sStream, index) => {
        const lang = sStream.tags?.language || `und`;
        const name = sStream.tags?.title || `Subtitle ${index + 1}`;
        masterContent += `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="${subGroup}",LANGUAGE="${lang}",NAME="${name}",DEFAULT=NO,URI="Subtitle_Files/subtitle_${index}.vtt"\n`;
    });

    parsedStreams.videoStreams.forEach((vStream) => {
        const resolution = `${vStream.width}x${vStream.height}`;
        const bandwidth = 5000000;
        masterContent += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${resolution},CODECS="avc1.42e00a,mp4a.40.2",AUDIO="${audioGroup}",SUBTITLES="${subGroup}"\n`;
        masterContent += `video_stream.m3u8\n`;
    });

    fs.writeFileSync(path.join(hlsDir, 'master.m3u8'), masterContent);
}

function executeFfmpegCommand(inputFile, parsedStreams, hlsDir) {
    return new Promise(async (resolve, reject) => {
        // Store all chunks flat inside hls_output but with distinct prefixes
        // video_chunk_NNN.ts, audio0_chunk_NNN.ts, etc.
        // This avoids subdirectory relative-path issues in the m3u8.
        const hlsOptions = [
            '-f', 'hls',
            '-hls_time', '10',
            '-hls_playlist_type', 'vod',
        ];

        try {
            if (parsedStreams.videoStreams.length > 0) {
                console.log('Encoding Video Stream...');
                await new Promise((vResolve, vReject) => {
                    ffmpeg(inputFile)
                        .outputOptions([
                            '-map', '0:v:0',
                            '-c:v', 'libx264',
                            '-preset', 'fast',
                            '-crf', '22',
                            ...hlsOptions,
                            '-hls_segment_filename', path.join(hlsDir, 'video_chunk_%03d.ts')
                        ])
                        .output(path.join(hlsDir, 'video_stream.m3u8'))
                        .on('end', vResolve)
                        .on('error', vReject)
                        .run();
                });
            }

            console.log('Encoding Audio Streams...');
            if (parsedStreams.audioStreams.length === 0) {
                await new Promise((aResolve, aReject) => {
                    ffmpeg()
                        .input('anullsrc').inputFormat('lavfi')
                        .outputOptions([
                            '-map', '0:a',
                            '-c:a', 'aac',
                            '-ac', '2',
                            '-t', '20',
                            ...hlsOptions,
                            '-hls_segment_filename', path.join(hlsDir, 'audio0_chunk_%03d.ts')
                        ])
                        .output(path.join(hlsDir, 'audio_stream_0.m3u8'))
                        .on('end', aResolve)
                        .on('error', aReject)
                        .run();
                });
            } else {
                for (let index = 0; index < parsedStreams.audioStreams.length; index++) {
                    await new Promise((aResolve, aReject) => {
                        ffmpeg(inputFile)
                            .outputOptions([
                                '-map', `0:a:${index}`,
                                '-c:a', 'aac',
                                '-ac', '2',
                                ...hlsOptions,
                                '-hls_segment_filename', path.join(hlsDir, `audio${index}_chunk_%03d.ts`)
                            ])
                            .output(path.join(hlsDir, `audio_stream_${index}.m3u8`))
                            .on('end', aResolve)
                            .on('error', aReject)
                            .run();
                    });
                }
            }

            console.log('Extracting Subtitles...');
            const subtitlePromises = parsedStreams.subtitleStreams.map((sStream, index) => {
                return new Promise((subResolve, subReject) => {
                    const subPath = path.join(hlsDir, 'Subtitle_Files', `subtitle_${index}.vtt`);
                    ffmpeg(inputFile)
                        .outputOptions([
                            '-map', `0:s:${index}`,
                            '-c:s', 'webvtt'
                        ])
                        .output(subPath)
                        .on('end', subResolve)
                        .on('error', subReject)
                        .run();
                });
            });
            await Promise.all(subtitlePromises);

            writeMasterPlaylist(parsedStreams, hlsDir);
            resolve();
        } catch (err) {
            reject(err);
        }
    });
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error('Usage: node index.js <input_media_file> <tmdb_id>');
        process.exit(1);
    }

    const [inputFile, tmdbId] = args;
    const resolvedInputPath = path.resolve(inputFile);

    if (!fs.existsSync(resolvedInputPath)) {
        console.error(`Input file not found: ${resolvedInputPath}`);
        process.exit(1);
    }

    try {
        console.log(`Analyzing media: ${resolvedInputPath}`);
        const metadata = await analyzeMedia(resolvedInputPath);
        console.log('Metadata extracted successfully.', metadata.format.duration);
        
        const parsedStreams = parseStreams(metadata);
        console.log(`Found: ${parsedStreams.videoStreams.length} Video, ${parsedStreams.audioStreams.length} Audio, ${parsedStreams.subtitleStreams.length} Subtitle streams.`);

        const movieTitle = path.parse(resolvedInputPath).name; // Could be passed as arg.
        const hlsDir = buildDirectoryStructure(tmdbId);
        
        console.log(`Output Directory: ${hlsDir}`);

        console.log('Generating JSON Manifest...');
        const manifestPath = generateManifest(movieTitle, tmdbId, parsedStreams, hlsDir);
        console.log(`Manifest saved to: ${manifestPath}`);

        console.log('Starting FFmpeg Processing... This may take a while depending on file size.');
        await executeFfmpegCommand(resolvedInputPath, parsedStreams, hlsDir);
        
        console.log('HLS Encoding process completed successfully!');
    } catch (error) {
        console.error('Error analyzing media:', error.message);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    analyzeMedia,
};
