// ==========================================
// Deepgram v3 — JSON + base64 PCM16 stream
// Unity sends: {"type":"audio_chunk","sampleRate":16000,"audio":"<base64>"}
// ==========================================

const http = require("http");
const WebSocket = require("ws");
const { createClient } = require("@deepgram/sdk");
const OpenAI = require("openai");

// Инициализация клиентов
const dg = createClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// HTTP-заглушка для Render
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Deepgram server OK");
});

// WebSocket сервер
const wss = new WebSocket.Server({ server, path: "/ws" });
console.log("WebSocket ready.");

wss.on("connection", async (ws) => {
  console.log("Client connected");

  // Heartbeat, чтобы Render не рвал соединение
  const pingInterval = setInterval(() => {
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {}
  }, 8000);

  // --- Deepgram live сессия (SDK v3, правильный namespace) ---
  const live = await dg.transcription.live({
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

  // ГЛАВНОЕ: правильное событие в v3 — "transcriptReceived"
  live.on("transcriptReceived", async (dgEvent) => {
    try {
      const alt = dgEvent?.channel?.alternatives?.[0];
      const transcript = alt?.transcript?.trim();

      if (!transcript || transcript.length < 2) {
        // шум / тишина
        return;
      }

      console.log("STT:", transcript);

      // --- GPT ответ ---
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: transcript }],
        temperature: 0.2,
        max_tokens: 200,
      });

      const answer = resp.choices?.[0]?.message?.content?.trim() || "";
      console.log("LLM:", answer);

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

  // --- Приём JSON от Unity ---
  ws.on("message", (data) => {
    let obj;
    try {
      const text = data.toString("utf8");
      // можно раскомментить если хочешь видеть сырой текст
      // console.log("RAW WS:", text.slice(0, 200));
      obj = JSON.parse(text);
    } catch {
      // не JSON — игнорим (например, бинарь или мусор)
      return;
    }

    if (obj.type !== "audio_chunk" || !obj.audio) return;

    // base64 → Buffer (PCM16)
    const pcm = Buffer.from(obj.audio, "base64");
    if (!pcm.length) return;

    console.log("PCM bytes decoded:", pcm.length);

    // Шлём сырой PCM в Deepgram
    try {
      live.send(pcm);
    } catch (err) {
      console.error("Deepgram send error:", err);
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

// START
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Listening on port", PORT));