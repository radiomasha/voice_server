// ===============================
// Deepgram v3 Streaming Server
// UNITY PCM16 16kHz
// ===============================

const http = require("http");
const WebSocket = require("ws");
const { createClient } = require("@deepgram/sdk"); // <-- ВАЖНО
const OpenAI = require("openai");

// Init API clients
const dg = createClient(process.env.DEEPGRAM_API_KEY); // <-- ВАЖНО
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// HTTP stub for Render
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Deepgram server OK");
});

// WebSocket server
const wss = new WebSocket.Server({ server, path: "/ws" });
console.log("WebSocket ready.");

wss.on("connection", async (ws) => {
  console.log("Client connected");

  // --- DEEPGRAM LIVE STREAM (SDK v3 correct format) ---
  const live = await dg.listen.live({
    model: "nova-2",
    language: "en",
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
    vad_events: true,
    punctuate: true,
    interim_results: false
  });

  live.on("open", () => console.log("Deepgram live session opened"));

  // STT event
  live.on("transcript", async (dgData) => {
    const transcript =
      dgData?.channel?.alternatives?.[0]?.transcript?.trim() || "";

    if (!transcript || transcript.length < 2) return; // ignore silence

    console.log("STT:", transcript);

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