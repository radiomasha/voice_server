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

// WebSocket сервер
const wss = new WebSocket.Server({
  server,
  path: "/ws",
  maxPayload: 1024 * 1024,
  perMessageDeflate: false,
});

console.log("WebSocket ready.");

wss.on("connection", async (ws) => {
  console.log("Client connected");

  // Пинг, чтобы Render не рвал соединение
  const pingInterval = setInterval(() => {
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {}
  }, 8000);

  // --- Deepgram live session (v3, raw PCM) ---
  const live = await dg.listen.live({
    model: "nova-2",
    language: "en",
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
    raw: true,               // сырые PCM-байты
    vad_events: true,
    interim_results: false,
    punctuate: true,
  });

  live.on("open", () => console.log("Deepgram session opened."));
  live.on("close", () => console.log("Deepgram closed"));
  live.on("error", (err) => console.error("Deepgram ERROR:", err));

  // --- Deepgram → текст ---
  live.on("transcript", async (data) => {
    try {
      const transcript =
        data?.channel?.alternatives?.[0]?.transcript?.trim() || "";

      if (!transcript || transcript.length < 2) {
        // шум / тишина
        return;
      }

      console.log("STT:", transcript);

      // --- GPT ---
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: transcript }],
        temperature: 0.2,
        max_tokens: 200,
      });

      const answer = resp.choices?.[0]?.message?.content?.trim() || "";
      console.log("LLM:", answer);

      // --- ответ в Unity ---
      ws.send(
        JSON.stringify({
          type: "llm_response",
          transcript,
          response: answer,
        })
      );
    } catch (err) {
      console.error("LLM or send error:", err);
    }
  });

  // --- Unity → PCM ---
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
      console.error("Deepgram send error:", err);
    }
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    console.log("Client disconnected");
    try {
      live.finish();
    } catch {}
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Listening on port", PORT));