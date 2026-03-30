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

const os = require('os');

async function stitchHlsPlaylists(subPlaylistPaths, finalPlaylistPath, hlsDir) {
    let finalContent = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:15\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n';
    let totalSegments = 0;

    for (let i = 0; i < subPlaylistPaths.length; i++) {
        const content = fs.readFileSync(subPlaylistPaths[i], 'utf8');
        const lines = content.split('\n');
        
        lines.forEach(line => {
            if (line.startsWith('#EXTINF:')) {
                finalContent += line + '\n';
            } else if (line.endsWith('.ts')) {
                // Rename and move segment to maintain continuous sequence
                const oldPath = path.join(hlsDir, line);
                const newFileName = `video_chunk_${String(totalSegments).padStart(3, '0')}.ts`;
                const newPath = path.join(hlsDir, newFileName);
                
                if (fs.existsSync(oldPath)) {
                    fs.renameSync(oldPath, newPath);
                }
                finalContent += newFileName + '\n';
                totalSegments++;
            }
        });
    }

    finalContent += '#EXT-X-ENDLIST';
    fs.writeFileSync(finalPlaylistPath, finalContent);
    
    // Clean up sub-playlists
    subPlaylistPaths.forEach(p => {
        if (fs.existsSync(p)) fs.unlinkSync(p);
    });
}

function executeFfmpegCommand(inputFile, parsedStreams, hlsDir, duration) {
    return new Promise(async (resolve, reject) => {
        const hlsOptions = [
            '-f', 'hls',
            '-hls_time', '10',
            '-hls_playlist_type', 'vod',
        ];

        const tasks = [];

        // 1. Video Encoding Task (Temporal Parallelization)
        if (parsedStreams.videoStreams.length > 0) {
            tasks.push(new Promise(async (vGrpResolve, vGrpReject) => {
                const numWorkers = Math.min(os.cpus().length, 4);
                const partDuration = Math.ceil(duration / numWorkers);
                const videoTasks = [];
                const subPlaylists = [];

                console.log(`Dividing video timeline into ${numWorkers} parts for parallel encoding...`);

                for (let i = 0; i < numWorkers; i++) {
                    const startTime = i * partDuration;
                    const subPlaylist = path.join(hlsDir, `video_part_${i}.m3u8`);
                    subPlaylists.push(subPlaylist);

                    videoTasks.push(new Promise((vResolve, vReject) => {
                        ffmpeg(inputFile)
                            .inputOptions([`-ss`, String(startTime)])
                            .outputOptions([
                                '-t', String(partDuration),
                                '-map', '0:v:0',
                                '-c:v', 'libx264',
                                '-preset', 'fast',
                                '-crf', '22',
                                ...hlsOptions,
                                '-hls_segment_filename', path.join(hlsDir, `video_part_${i}_chunk_%03d.ts`)
                            ])
                            .output(subPlaylist)
                            .on('end', vResolve)
                            .on('error', vReject)
                            .run();
                    }));
                }

                try {
                    await Promise.all(videoTasks);
                    console.log('All video parts transcoded. Stitching playlists...');
                    await stitchHlsPlaylists(subPlaylists, path.join(hlsDir, 'video_stream.m3u8'), hlsDir);
                    console.log('Video Stream Unified Successfully.');
                    vGrpResolve();
                } catch (err) {
                    vGrpReject(err);
                }
            }));
        }

        // 2. Audio Encoding Tasks (Parallel)
        if (parsedStreams.audioStreams.length === 0) {
            tasks.push(new Promise((aResolve, aReject) => {
                console.log('Starting Silent Audio Generation...');
                ffmpeg()
                    .input('anullsrc').inputFormat('lavfi')
                    .outputOptions([
                        '-map', '0:a',
                        '-c:a', 'aac',
                        '-ac', '2',
                        '-t', String(duration),
                        ...hlsOptions,
                        '-hls_segment_filename', path.join(hlsDir, 'audio0_chunk_%03d.ts')
                    ])
                    .output(path.join(hlsDir, 'audio_stream_0.m3u8'))
                    .on('end', aResolve)
                    .on('error', aReject)
                    .run();
            }));
        } else {
            parsedStreams.audioStreams.forEach((aStream, index) => {
                tasks.push(new Promise((aResolve, aReject) => {
                    console.log(`Starting Audio Stream ${index} Encoding...`);
                    ffmpeg(inputFile)
                        .outputOptions([
                            '-map', `0:a:${index}`,
                            '-c:a', 'aac',
                            '-ac', '2',
                            ...hlsOptions,
                            '-hls_segment_filename', path.join(hlsDir, `audio${index}_chunk_%03d.ts`)
                        ])
                        .output(path.join(hlsDir, `audio_stream_${index}.m3u8`))
                        .on('end', () => {
                            console.log(`Audio Stream ${index} Encoding Completed.`);
                            aResolve();
                        })
                        .on('error', (err) => {
                            console.error(`Audio Stream ${index} Error:`, err.message);
                            aReject(err);
                        })
                        .run();
                }));
            });
        }

        // 3. Subtitle Extraction Task (Parallel)
        if (parsedStreams.subtitleStreams.length > 0) {
            tasks.push(new Promise(async (subGroupResolve, subGroupReject) => {
                console.log('Starting Subtitle Extraction...');
                const subtitleTracks = parsedStreams.subtitleStreams.map((sStream, index) => {
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

                try {
                    await Promise.all(subtitleTracks);
                    console.log('Subtitle Extraction Completed.');
                    subGroupResolve();
                } catch (err) {
                    console.error('Subtitle Extraction Error:', err.message);
                    subGroupReject(err);
                }
            }));
        }

        try {
            console.log(`Parallelizing stream and timeline tasks...`);
            await Promise.all(tasks);
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
        const duration = parseFloat(metadata.format.duration);
        await executeFfmpegCommand(resolvedInputPath, parsedStreams, hlsDir, duration);
        
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
