// ==========================================
// Deepgram v3 — JSON PCM Stream Server
// Unity sends JSON { type, sampleRate, audio(base64) }
// ==========================================

const http = require("http");
const WebSocket = require("ws");
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const OpenAI = require("openai");

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Deepgram server OK");
});

const wss = new WebSocket.Server({ server, path: "/ws" });
console.log("WebSocket ready.");

wss.on("connection", async (ws) => {
  console.log("Client connected");

  // Heartbeat (Render idle fix)
  const pingInterval = setInterval(() => {
    try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
  }, 8000);

  // -------------------------
  // Deepgram: create stream
  // -------------------------
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

  // ---- Deepgram events ----
  live.on(LiveTranscriptionEvents.Open, () => {
    console.log("Deepgram session opened.");
    try {
      live.start();           // <<<<<<<<< ОБЯЗАТЕЛЬНО
      console.log("Deepgram stream STARTED.");
    } catch (err) {
      console.error("Deepgram start() error:", err);
    }
  });

  live.on(LiveTranscriptionEvents.Error, (err) =>
    console.error("Deepgram ERROR:", err)
  );

  // -------------------------
  // TRANSCRIPT HANDLER
  // -------------------------
  live.on(LiveTranscriptionEvents.Transcript, async (event) => {
    try {
      const alt = event?.channel?.alternatives?.[0];
      const transcript = (alt?.transcript || "").trim();

      if (!transcript || transcript.length < 2) return;

      console.log("STT:", transcript);

      // LLM response
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: transcript }],
        max_tokens: 200,
        temperature: 0.3,
      });

      const answer =
        resp.choices?.[0]?.message?.content?.trim() || "No answer.";

      console.log("LLM:", answer);

      ws.send(JSON.stringify({
        type: "llm_response",
        transcript,
        response: answer,
      }));
    } catch (err) {
      console.error("Transcript handler error:", err);
    }
  });

  // -------------------------
  // RECEIVE FROM UNITY
  // -------------------------
  ws.on("message", (msg) => {
    try {
      let text = Buffer.isBuffer(msg) ? msg.toString("utf8") : msg;

      let obj;
      try {
        obj = JSON.parse(text);
      } catch {
        console.warn("Non-JSON ignored");
        return;
      }

      if (obj.type !== "audio_chunk") return;

      const pcm = Buffer.from(obj.audio, "base64");
      console.log("PCM bytes received:", pcm.length);

      live.send(pcm); // send to Deepgram
    } catch (err) {
      console.error("WS message error:", err);
    }
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    try { live.finish(); } catch {}
    console.log("Client disconnected");
  });
});

// -------------------------
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Listening on port", PORT));