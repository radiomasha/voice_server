// ==========================================
// Deepgram v3 — JSON PCM Stream Server
// Unity sends JSON { type, sampleRate, audio(base64) }
// ==========================================

const http = require("http");
const WebSocket = require("ws");
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const OpenAI = require("openai");

// ---- INIT CLIENTS ----
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- HTTP (Render healthcheck) ----
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Deepgram server OK");
});

// ---- WebSocket /ws ----
const wss = new WebSocket.Server({ server, path: "/ws" });
console.log("WebSocket ready.");

// =========================
// WS CONNECTION
// =========================
wss.on("connection", async (ws) => {
  console.log("Client connected");

  // Heartbeat, чтобы Render не отваливался по idle
  const pingInterval = setInterval(() => {
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {}
  }, 8000);

  // ---- Deepgram live session ----
  const live = deepgram.listen.live({
    model: "nova-2",
    language: "en",
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
    vad_events: true,
    interim_results: false,
    smart_format: true,
  });

  // Логи Deepgram
  live.on(LiveTranscriptionEvents.Open, () =>
    console.log("Deepgram session opened.")
  );
  live.on(LiveTranscriptionEvents.Error, (err) =>
    console.error("Deepgram ERROR:", err)
  );

  // === КЛЮЧЕВОЕ МЕСТО: получаем транскрипцию от Deepgram ===
  live.on(LiveTranscriptionEvents.Transcript, async (event) => {
    try {
      const alt = event?.channel?.alternatives?.[0];
      const transcript = (alt?.transcript || "").trim();

      if (!transcript || transcript.length < 2) {
        // шум/тишина → пропускаем
        return;
      }

      console.log("STT:", transcript);

      // ---- LLM (OpenAI) ----
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: transcript }],
        max_tokens: 200,
        temperature: 0.4,
      });

      const answer =
        resp.choices?.[0]?.message?.content?.trim() ||
        "Sorry, I couldn't think of a response.";

      console.log("LLM:", answer);

      // Отправляем Unity
      ws.send(
        JSON.stringify({
          type: "llm_response",
          transcript,
          response: answer,
        })
      );
    } catch (err) {
      console.error("LLM pipeline error:", err);
    }
  });

  // === ПРИЁМ АУДИО ОТ UNITY ===
  ws.on("message", (msg) => {
    try {
      let text;

      if (Buffer.isBuffer(msg)) {
        text = msg.toString("utf8");
      } else if (typeof msg === "string") {
        text = msg;
      } else {
        console.warn("Unknown message type from client");
        return;
      }

      let obj;
      try {
        obj = JSON.parse(text);
      } catch (e) {
        console.warn("Non-JSON message ignored");
        return;
      }

      if (obj.type !== "audio_chunk" || !obj.audio) {
        // игнорируем всё, что не наш аудио-пакет
        return;
      }

      const pcm = Buffer.from(obj.audio, "base64");
      console.log("PCM bytes received:", pcm.length);

      // Шлём аудио в Deepgram
      live.send(pcm);
    } catch (err) {
      console.error("WS message handler error:", err);
    }
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    try {
      live.finish();
    } catch {}
    console.log("Client disconnected");
  });
});

// ---- START ----
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Listening on port", PORT));