
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// HTTP server for Render
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("Voice WS server");
});

const wss = new WebSocket.Server({ server, path: "/ws" });

wss.on("connection", (ws) => {
    console.log("Client connected");

    let chunks = [];
    let sampleRate = 16000;
    let bytesCollected = 0;

    ws.on("message", async (message) => {
        let obj;
        try {
            obj = JSON.parse(message.toString());
        } catch {
            console.warn("Invalid JSON");
            return;
        }

        if (obj.type !== "audio_chunk") return;

        const pcm16 = Buffer.from(obj.audio, "base64");
        sampleRate = obj.sampleRate ?? sampleRate;

        chunks.push(pcm16);
        bytesCollected += pcm16.length;

        const bytesPerSec = sampleRate * 2;
        const needed = bytesPerSec * 2; // ~2 seconds chunks

        if (bytesCollected >= needed) {
            // finalize audio
            const buf = Buffer.concat(chunks);
            chunks = [];
            bytesCollected = 0;

            const filename = `/tmp/audio_${uuidv4()}.wav`;
            saveWav(buf, sampleRate, filename);

            // --- TRANSCRIBE ---
            const transcript = await transcribe(filename);
            console.log("Transcript:", transcript);

            // Ignore empty/noise transcripts
            if (!transcript || transcript.trim().length < 2) {
                console.log("Ignored short transcript");
                return;
            }

            // --- LLM RESPONSE ---
           
if (!transcript || transcript.trim().length < 3) {
    console.log("Silence detected — no LLM call.");
    return;
}

const llmResponse = await safeQueryLLM(transcript);

safeSend(ws, {
    type: 'llm_response',
    transcript,
    response: llmResponse,
    filename
});
        }
    });

    ws.on("close", () => console.log("Client disconnected"));
});

// ---- Helpers ----

function safeSend(ws, obj) {
    try {
        ws.send(JSON.stringify(obj));
    } catch (err) {
        console.error("Send error:", err);
    }
}

function saveWav(pcmBuffer, sampleRate, outPath) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * bitsPerSample / 8;
    const blockAlign = numChannels * bitsPerSample / 8;
    const dataSize = pcmBuffer.length;

    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);

    fs.writeFileSync(outPath, Buffer.concat([header, pcmBuffer]));
}

async function transcribe(path) {
    try {
        const resp = await openai.audio.transcriptions.create({
            file: fs.createReadStream(path),
            model: "whisper-1"
        });
        return resp.text || "";
    } catch (e) {
        console.error("STT error", e);
        return "";
    }
}

async function runLLM(prompt) {
    try {
        const r = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.6,
            max_tokens: 150
        });
        return r.choices?.[0]?.message?.content || "";
    } catch (e) {
        console.error("LLM error", e);
        return "I'm sorry, I couldn't process that.";
    }
}

// START
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Listening on", PORT));