// server.js (drop-in for Render)
// Requirements: node 18+, packages: ws, uuid, openai
// Env: OPENAI_API_KEY

const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai');

// --- Init OpenAI client ---
if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set in environment!");
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- HTTP server (Render expects a web service) ---
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Voice WS server');
});

// --- WebSocket server on path /ws ---
const wss = new WebSocket.Server({ server, path: '/ws' });

console.log('WS server created, waiting for connections...');

// --- Periodic cleanup of /tmp audio files (1 hour) ---
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
const TMP_DIR = '/tmp';
setInterval(() => {
    fs.readdir(TMP_DIR, (err, files) => {
        if (err) return;
        files.filter(f => f.startsWith('audio_') && f.endsWith('.wav')).forEach(f => {
            const p = `${TMP_DIR}/${f}`;
            fs.unlink(p, (err) => {
                if (!err) console.log('Deleted old audio file:', f);
            });
        });
    });
}, CLEANUP_INTERVAL);

// --- WebSocket connection handler ---
wss.on('connection', (ws, req) => {
    console.log('Client connected from', req.socket.remoteAddress);

    let chunks = [];
    let sampleRate = 16000;
    let bytesCollected = 0;

    ws.on('message', async (message) => {
        try {
            if (!message) return;
            const str = message.toString();
            if (!str) return;

            let obj;
            try {
                obj = JSON.parse(str);
            } catch (parseErr) {
                console.warn('Received non-JSON message; ignoring. raw:', str.substring(0, 200));
                return;
            }

            if (obj.type === 'audio_chunk') {
                sampleRate = obj.sampleRate || sampleRate;
                if (!obj.audio) {
                    console.warn('audio_chunk missing audio field');
                    return;
                }

                const pcm16 = Buffer.from(obj.audio, 'base64');
                if (!Buffer.isBuffer(pcm16) || pcm16.length === 0) {
                    console.warn('empty pcm16 buffer');
                    return;
                }

                chunks.push(pcm16);
                bytesCollected += pcm16.length;

                console.log('Received audio chunk, bytes:', pcm16.length);

                const bytesPerSec = sampleRate * 2;
                if (bytesCollected >= bytesPerSec * 2) {
                    const buffers = Buffer.concat(chunks);
                    chunks = [];
                    bytesCollected = 0;

                    const filename = `/tmp/audio_${uuidv4()}.wav`;
                    try {
                        saveAsWav(buffers, sampleRate, filename);
                        console.log('Saved', filename);
                    } catch (saveErr) {
                        console.error('Failed to save WAV:', saveErr);
                        safeSend(ws, { type: 'llm_response', transcript: '', response: 'Server failed to save audio', filename: '' });
                        return;
                    }

                    // === INSERTED PROCESSING PIPELINE ===
                    try {
                        // immediate quick ack so Unity knows server started processing
                        safeSend(ws, { type: 'transcript', text: 'processing...', filename });

                        console.log('Calling STT for file:', filename);
                        const transcript = await safeTranscribe(filename);
                        console.log('Transcript received from STT:', transcript);

                        // send updated transcript (for quick UI feedback)
                        safeSend(ws, { type: 'transcript', text: transcript, filename });

                        console.log('Calling LLM with transcript (length', (transcript||'').length, ')');
                        const llmResponse = await safeQueryLLM(transcript);
                        console.log('LLM response:', llmResponse);

                        // final reply to client
                        safeSend(ws, {
                            type: 'llm_response',
                            transcript: transcript,
                            response: llmResponse,
                            filename: filename
                        });

                    } catch (err) {
                        console.error('ERROR in processing pipeline (STT/LLM):', err);
                        safeSend(ws, { type: 'llm_response', transcript: '', response: 'Server processing error', filename });
                    }
                    // === END INSERTED PIPELINE ===
                }
            } else if (obj.type === 'control') {
                console.log('Control message:', obj);
            } else {
                console.log('Unknown message type:', obj.type);
            }
        } catch (e) {
            console.error('Error handling incoming message:', e);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });

    ws.on('error', (err) => {
        console.error('WS error:', err);
    });
});

// --- Helper: safe send stringified JSON ---
function safeSend(ws, obj) {
    try {
        const str = JSON.stringify(obj);
        ws.send(str);
        console.log('Sent to client:', str.substring(0, 800));
    } catch (e) {
        console.error('safeSend failed:', e);
    }
}

// --- Save PCM16 LE buffer as WAV ---
function saveAsWav(pcmBuffer, sampleRate, outPath) {
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

    fs.writeFileSync(outPath, Buffer.concat([header, pcmBuffer]));
}

// --- STT using OpenAI Whisper (safe wrapper) ---
async function safeTranscribe(path) {
    try {
        if (!fs.existsSync(path)) {
            console.warn('transcribeAudio: file not found', path);
            return '';
        }
        const resp = await openai.audio.transcriptions.create({
            file: fs.createReadStream(path),
            model: "whisper-1"
        });
        return resp.text || '';
    } catch (err) {
        console.error('safeTranscribe error:', err);
        return '';
    }
}

// --- LLM query (safe wrapper) ---
async function safeQueryLLM(prompt) {
    try {
        const effectivePrompt = (prompt && prompt.length > 0) ? prompt : '(no transcript)';
        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: effectivePrompt }],
            temperature: 0.7,
            max_tokens: 512
        });
        const text = completion?.choices?.[0]?.message?.content;
        return text || '';
    } catch (err) {
        console.error('safeQueryLLM error:', err);
        return 'Error: LLM request failed';
    }
}

// --- Start server ---
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
});