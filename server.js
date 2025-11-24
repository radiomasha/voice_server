// ==========================================
// Deepgram v3 — Binary PCM Stream Server
// Unity шлёт raw PCM16 (БЕЗ JSON)
// ==========================================

const http = require("http");
const WebSocket = require("ws");
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const OpenAI = require("openai");

const dg = createClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// HTTP для Render
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

  // Пинг, чтобы Render не рвал коннект
  const pingInterval = setInterval(() => {
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {}
  }, 8000);

  // === Deepgram live-сессия (SDK v3, WebSocket) ===
  const live = await dg.listen.live({
    model: "nova-2",
    language: "en",
    encoding: "linear16", // мы шлём PCM16
    sample_rate: 16000,   // мы даунсэмплим до 16k в Unity
    channels: 1,
    vad_events: true,
    interim_results: false,
    punctuate: true,
  });

  // ошибки Deepgram
  live.on(LiveTranscriptionEvents.Error, (err) => {
    console.error("Deepgram ERROR:", err);
  });

  live.on(LiveTranscriptionEvents.Close, () => {
    console.log("Deepgram closed");
  });

  // когда WebSocket Deepgram открылся
  live.on(LiveTranscriptionEvents.Open, () => {
    console.log("Deepgram session opened.");

    // КЛЮЧЕВОЕ: правильное событие транскрипта v3
    live.on(LiveTranscriptionEvents.Transcript, async (data) => {
      const transcript =
        data?.channel?.alternatives?.[0]?.transcript?.trim() || "";

      if (!transcript || transcript.length < 2) return;

      console.log("STT:", transcript);

      try {
        const resp = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: transcript }],
          temperature: 0.2,
          max_tokens: 200,
        });

        const answer =
          resp.choices?.[0]?.message?.content?.trim() || "";

        console.log("LLM:", answer);

        ws.send(
          JSON.stringify({
            type: "llm_response",
            transcript,
            response: answer,
          })
        );
      } catch (err) {
        console.error("GPT error:", err);
      }
    });
  });

  // Unity шлёт СЫРОЙ PCM16 (НЕ JSON)
  ws.on("message", (buffer) => {
    if (!Buffer.isBuffer(buffer)) return;

    console.log("PCM bytes received:", buffer.length);
    live.send(buffer);
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    try {
      live.close(); // для live WebSocket
    } catch {}
    console.log("Client disconnected");
  });
});

// Старт
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Listening on port", PORT));