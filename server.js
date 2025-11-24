// ================================================
// Deepgram v3 — RAW PCM Streaming Server (WORKING)
// ================================================

const http = require("http");
const WebSocket = require("ws");
const { createClient } = require("@deepgram/sdk");
const OpenAI = require("openai");

const dg = createClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Server OK");
});

const wss = new WebSocket.Server({ server, path: "/ws" });
console.log("WS ready.");

wss.on("connection", async (ws) => {
  console.log("Client connected");

  // --- Deepgram Live Session (WORKING) ---
  const live = await dg.listen.live({
    model: "nova-2",
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
    vad_events: true,
    interim_results: false,
    punctuate: true,
  });

  live.on("open", () => console.log("Deepgram OPEN"));
  live.on("error", (e) => console.error("DG ERROR", e));

  live.on("transcript", async (d) => {
    const t = d?.channel?.alternatives?.[0]?.transcript?.trim();
    if (!t) return;

    console.log("STT:", t);

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: t }],
      max_tokens: 150,
      temperature: 0.2,
    });

    const answer = resp.choices?.[0]?.message?.content?.trim() || "";
    console.log("LLM:", answer);

    ws.send(JSON.stringify({
      type: "llm_response",
      transcript: t,
      response: answer
    }));
  });

  // --- RECEIVE RAW PCM BYTES ---
  ws.on("message", (buffer) => {
    if (!Buffer.isBuffer(buffer)) return;
    live.send(buffer);
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    try { live.finish(); } catch {}
  });
});

server.listen(10000, () => console.log("Listening on 10000"));