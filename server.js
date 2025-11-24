// ===============================
// Deepgram v3 Streaming Server
// UNITY PCM16 16kHz
// ===============================

const http = require("http");
const WebSocket = require("ws");
const { Deepgram } = require("@deepgram/sdk");
const OpenAI = require("openai");

// Init API clients
const dg = new Deepgram(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// HTTP (Render needs it)
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Deepgram server OK");
});

// WebSocket server
const wss = new WebSocket.Server({ server, path: "/ws" });
console.log("WebSocket ready.");

wss.on("connection", async (ws) => {
  console.log("Client connected");

  // --- CREATE LIVE DEEPGRAM CONNECTION (v3 syntax) ---
  const live = await dg.listening.live({
    model: "nova-2",
    language: "en",
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
    vad_events: true,
    punctuate: true,
    interim_results: false
  });

  console.log("Deepgram live session opened");

  // Receive STT results
  live.on("transcript", async (dgData) => {
    const transcript =
      dgData?.channel?.alternatives?.[0]?.transcript?.trim() || "";

    if (!transcript || transcript.length < 2) return; // ignore silence

    console.log("STT:", transcript);

    // === CALL GPT ===
    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: transcript }],
        temperature: 0.4,
        max_tokens: 200
      });

      const text = resp.choices?.[0]?.message?.content?.trim() || "";
      console.log("LLM:", text);

      ws.send(
        JSON.stringify({
          type: "llm_response",
          transcript,
          response: text
        })
      );
    } catch (err) {
      console.error("GPT error:", err);
    }
  });

  // Receive PCM audio from Unity
  ws.on("message", (msg) => {
    let obj;
    try {
      obj = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (obj.type !== "audio_chunk") return;

    const pcm = Buffer.from(obj.audio, "base64");
    live.send(pcm);
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    live.close();
  });
});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Listening on port", PORT));