// ==========================================
// Deepgram v3 — Binary PCM Stream Server
// Unity sends raw PCM16 bytes (no JSON)
// ==========================================

const http = require("http");
const WebSocket = require("ws");
const { createClient } = require("@deepgram/sdk");
const OpenAI = require("openai");

const dg = createClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Deepgram server OK");
});

const wss = new WebSocket.Server({ server, path: "/ws" });
console.log("WebSocket ready.");

wss.on("connection", async (ws) => {
  console.log("Client connected");

  const pingInterval = setInterval(() => {
    try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
  }, 8000);

  // CORRECT DEEPGRAM LIVE SESSION (NO .start())
  const live = await dg.listen.live({
    model: "nova-2",
    language: "en",
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
    vad_events: true,
    interim_results: false,
    punctuate: true,
  });

  live.on("open", () => console.log("Deepgram session opened."));
  live.on("error", (err) => console.error("Deepgram ERROR:", err));

  // STT EVENT
  live.on("transcript", async (data) => {
    const transcript = data?.channel?.alternatives?.[0]?.transcript?.trim();
    if (!transcript || transcript.length < 2) return;

    console.log("STT:", transcript);

    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: transcript }],
        temperature: 0.2,
        max_tokens: 200,
      });

      const answer = resp.choices?.[0]?.message?.content?.trim() || "";

      ws.send(JSON.stringify({
        type: "llm_response",
        transcript,
        response: answer,
      }));

      console.log("LLM:", answer);

    } catch (err) {
      console.error("GPT error:", err);
    }
  });

  // RECEIVE RAW PCM BYTES
  ws.on("message", (buffer) => {
    if (!Buffer.isBuffer(buffer)) return;

    // Debug
    // console.log("PCM bytes received:", buffer.length);

    live.send(buffer);
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    try { live.finish(); } catch {}
    console.log("Client disconnected");
  });

});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Listening on port", PORT));