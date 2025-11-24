// ==========================================
// Deepgram SDK v3 — CORRECT CommonJS VERSION
// PCM16 binary streaming
// ==========================================

const http = require("http");
const WebSocket = require("ws");
const { createClient } = require("@deepgram/sdk");
const OpenAI = require("openai");

// Deepgram + OpenAI clients
const dg = createClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("DG server OK");
});

const wss = new WebSocket.Server({ server, path: "/ws" });
console.log("WebSocket ready");

// ==========================================
// CONNECTION
// ==========================================
wss.on("connection", async (ws) => {
  console.log("Client connected");

  // Keep-alive for Render
  const pingInterval = setInterval(() => {
    try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
  }, 8000);

  // -------------------------
  // OPEN DG STREAM — SDK v3
  // -------------------------
  const live = dg.listen.live({
    model: "nova-2",
    smart_format: true,
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
    interim_results: false,
    vad_events: true,
  });

  live.on("open", () => console.log("Deepgram session opened"));
  live.on("error", (err) => console.error("Deepgram ERROR:", err));

  // --------- CORRECT EVENT NAME ---------
  live.on("transcriptReceived", async (r) => {
    const transcript = r.channel.alternatives[0].transcript.trim();
    if (!transcript) return;

    console.log("STT:", transcript);

    // GPT
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: transcript }],
      max_tokens: 200,
      temperature: 0.2,
    });

    const answer = resp.choices[0].message.content.trim();

    ws.send(JSON.stringify({
      type: "llm_response",
      transcript,
      response: answer,
    }));

    console.log("LLM:", answer);
  });

  // PCM FROM UNITY
  ws.on("message", (buffer) => {
    if (!Buffer.isBuffer(buffer)) return;
    live.send(buffer);
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    try { live.finish(); } catch {}
    console.log("Client disconnected");
  });
});

// Start server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Listening on port", PORT));