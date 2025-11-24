// ==========================================
// Deepgram v3 RAW PCM Server (CommonJS)
// ==========================================

const http = require("http");
const WebSocket = require("ws");
const { createClient } = require("@deepgram/sdk");   // v3
const OpenAI = require("openai");

// init clients
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

  // Render WebSocket idle timeout fix
  const pingInterval = setInterval(() => {
    try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
  }, 8000);

  // Deepgram STREAM (RAW PCM)
  const live = await dg.listen.live({
    model: "nova-2",
    language: "en",
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
    vad_events: true,
    interim_results: false,
    punctuate: true
  });

  live.on("open", () => console.log("Deepgram session opened."));
  live.on("error", (err) => console.error("Deepgram ERROR:", err));

  // When Deepgram produces a transcript
  live.on("transcript", async (data) => {
    const text = data?.channel?.alternatives?.[0]?.transcript?.trim();
    if (!text || text.length < 2) return;

    console.log("STT:", text);

    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: text }],
        max_tokens: 200,
        temperature: 0.2
      });

      const answer = resp.choices?.[0]?.message?.content?.trim() || "";
      console.log("LLM:", answer);

      ws.send(JSON.stringify({
        type: "llm_response",
        transcript: text,
        response: answer
      }));

    } catch (err) {
      console.error("GPT error:", err);
    }
  });

  // RAW PCM incoming
  ws.on("message", (buffer) => {
    if (!Buffer.isBuffer(buffer)) return;

    // console.log("PCM bytes:", buffer.length);

    // send raw PCM bytes to deepgram
    live.send(buffer);
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    try { live.finish(); } catch {}
    console.log("Client disconnected");
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Listening on port", PORT));