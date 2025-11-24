// ===============================
// Deepgram Streaming STT VR Server (English-only)
// ===============================

const http = require("http");
const WebSocket = require("ws");
const { Deepgram } = require("@deepgram/sdk");
const OpenAI = require("openai");

// Initialize clients
const deepgram = new Deepgram(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Simple HTTP endpoint for Render health checks
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("Deepgram VR STT Server OK");
});

// Main WebSocket server
const wss = new WebSocket.Server({ server, path: "/ws" });
console.log("WebSocket server ready.");

wss.on("connection", async (ws) => {
    console.log("Client connected");

    // Create Deepgram live stream
    const dg = deepgram.listen.live({
        model: "nova-2",
        language: "en",           // You requested EN only
        smart_format: true,
        encoding: "linear16",
        sample_rate: 16000,
        channels: 1,
        interim_results: false,
        vad_events: true          // Deepgram will detect speech boundaries
    });

    // Deepgram stream events
    dg.on("open", () => console.log("Deepgram stream opened"));
    dg.on("close", () => console.log("Deepgram stream closed"));
    dg.on("error", (err) => console.error("Deepgram error:", err));

    // When Deepgram detects speech and returns text
    dg.on("transcriptReceived", async (data) => {
        try {
            const alt = data.channel.alternatives[0];
            if (!alt || !alt.transcript) return;

            const text = alt.transcript.trim();
            if (text.length < 2) return;  // ignore tiny noises

            console.log("STT:", text);

            // Now send text to LLM
            const llm = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: text }],
                max_tokens: 200,
                temperature: 0.5
            });

            const response = llm.choices[0].message.content.trim();
            console.log("LLM:", response);

            // Send processed message back to Unity
            ws.send(JSON.stringify({
                type: "llm_response",
                transcript: text,
                response: response
            }));

        } catch (err) {
            console.error("LLM processing error:", err);
        }
    });

    // Unity audio chunks → pass straight to Deepgram
    ws.on("message", (msg) => {
        let obj;
        try {
            obj = JSON.parse(msg.toString());
        } catch {
            return;
        }

        if (obj.type !== "audio_chunk") return;

        const pcm16 = Buffer.from(obj.audio, "base64");
        dg.send(pcm16);
    });

    // When Unity disconnects
    ws.on("close", () => {
        console.log("Client disconnected");
        dg.finish();
    });
});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Listening on", PORT));