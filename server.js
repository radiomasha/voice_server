// server.js
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

// Simple http server (used by Render)
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Voice WS server');
});

const wss = new WebSocket.Server({ server, path: '/ws' });

console.log('WS server created, waiting for connections...');

wss.on('connection', function connection(ws) {
    console.log('Client connected');

    let chunks = [];
    let sampleRate = 16000;
    let bytesCollected = 0;

    ws.on('message', function incoming(message) {
        try {
            // We expect JSON text frames from Unity (simple approach)
            const obj = JSON.parse(message.toString());
            if (obj.type === 'audio_chunk') {
                sampleRate = obj.sampleRate || sampleRate;
                const pcm16 = Buffer.from(obj.audio, 'base64'); // PCM16 LE
                chunks.push(pcm16);
                bytesCollected += pcm16.length;

                const bytesPerSec = sampleRate * 2; // 16-bit mono
                if (bytesCollected >= bytesPerSec * 2) { // when ~2 seconds collected
                    const buffers = Buffer.concat(chunks);
                    chunks = [];
                    bytesCollected = 0;
                    const filename = `/tmp/audio_${uuidv4()}.wav`;
                    saveAsWav(buffers, sampleRate, filename);
                    console.log('Saved', filename);

                    // Placeholder: here you would call STT/Hume/Whisper
                    // For demo, return simple response to client:
                    ws.send(JSON.stringify({ type: 'transcript', text: 'stub transcript', filename }));
                }
            } else if (obj.type === 'control') {
                // handle control messages (start/stop) if needed
            }
        } catch (e) {
            console.error('Error parsing message', e);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

function saveAsWav(pcmBuffer, sampleRate, path) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * bitsPerSample / 8;
    const blockAlign = numChannels * bitsPerSample / 8;
    const dataSize = pcmBuffer.length;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    fs.writeFileSync(path, Buffer.concat([header, pcmBuffer]));
}

// Start server on port from env OR default 8080
const port = process.env.PORT || 8080;
server.listen(port, () => {
    console.log(`Listening on port ${port}`);
});