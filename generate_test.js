const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegStatic);

console.log('Generating test_media.mp4...');

ffmpeg()
    .input('testsrc=duration=20:size=1280x720:rate=30')
    .inputFormat('lavfi')
    .input('sine=frequency=1000:duration=20')
    .inputFormat('lavfi')
    .outputOptions(['-c:v libx264', '-c:a aac', '-preset ultrafast'])
    .output('test_media.mp4')
    .on('end', () => {
        console.log('Test media generated successfully.');
        process.exit(0);
    })
    .on('error', (err) => {
        console.error('Error generating test media:', err);
        process.exit(1);
    })
    .run();
