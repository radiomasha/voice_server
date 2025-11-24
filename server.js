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
  perMessageDeflate: false
});

console.log("WebSocket ready.");

wss.on("connection", async (ws) => {
  console.log("Client connected");

  const pingInterval = setInterval(() => {
    try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
  }, 8000);

  let live;

  try {
    live = await dg.listen.live({
      model: "nova-2",
      language: "en",
      format: "pcm",               // <---- ВАЖНО
      encoding: "linear16",        // <---- ВАЖНО
      sample_rate: 16000,
      channels: 1,
      smart_format: true,
      vad_events: true,
      interim_results: false,
    });
  } catch (err) {
    console.error("Deepgram INIT ERROR:", err);
    return;
  }

  live.on("open", () => console.log("Deepgram session opened."));
  live.on("close", () => console.log("Deepgram closed"));
  live.on("error", (err) => console.error("Deepgram ERROR:", err));

  live.on("transcript", async (data) => {
    const t = data?.channel?.alternatives?.[0]?.transcript?.trim();
    if (!t) return;

    console.log("STT:", t);

    const gpt = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: t }],
      max_tokens: 150,
      temperature: 0.2,
    });

    const answer = gpt.choices?.[0]?.message?.content || "";

    ws.send(JSON.stringify({
      type: "llm_response",
      transcript: t,
      response: answer,
    }));

    console.log("LLM:", answer);
  });

  ws.on("message", (buffer) => {
    console.log("PCM bytes received:", buffer.length);
    if (live) live.send(buffer);
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    try { live.finish(); } catch {}
    console.log("Client disconnected");
  });

});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Listening on port", PORT));