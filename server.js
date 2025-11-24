// ==========================================
// Deepgram v3 — RAW PCM16 Streaming (работает)
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

const wss = new WebSocket.Server({
  server,
  path: "/ws",
  maxPayload: 1024 * 1024,
  perMessageDeflate: false,
});

console.log("WebSocket ready.");

wss.on("connection", async (ws) => {
  console.log("Client connected");

  const pingInterval = setInterval(() => {
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch (_) {}
  }, 8000);

  // ❗ Правильный Deepgram v3 live-сценарий
  const live = await dg.listen.live({
    model: "nova-2",
    format: "pcm16",     // ← вместо raw/encoding
    sample_rate: 16000,
    channels: 1,
    punctuate: true,
    vad_events: true,
    interim_results: false,
  });

  live.on("open", () => console.log("Deepgram session opened."));
  live.on("close", () => console.log("Deepgram closed"));
  live.on("error", (err) => console.error("Deepgram ERROR:", err));

  // Deepgram -> текст
  live.on("transcript", async (data) => {
    const transcript = data?.channel?.alternatives?.[0]?.transcript?.trim() || "";

    if (!transcript) return;

    console.log("STT:", transcript);

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: transcript }],
      temperature: 0.2,
      max_tokens: 200,
    });

    const answer = resp.choices?.[0]?.message?.content?.trim() || "";

    ws.send(
      JSON.stringify({
        type: "llm_response",
        transcript,
        response: answer,
      })
    );

    console.log("LLM:", answer);
  });

  // Unity → PCM
  ws.on("message", (buffer) => {
    if (!Buffer.isBuffer(buffer)) return;

    console.log("PCM bytes received:", buffer.length);

    if (live.getReadyState() !== "OPEN") {
      console.warn("Deepgram not open, skip PCM");
      return;
    }

    try {
      live.send(buffer);
    } catch (err) {
      console.error("Deepgram SEND error:", err);
    }
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    console.log("Client disconnected");
    try { live.finish(); } catch {}
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Listening on port", PORT));