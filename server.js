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

  let live = null;
  let dgReady = false;

  try {
    live = await dg.listen.live({
      model: "nova-2",
      language: "en",
      encoding: "linear16",
      sample_rate: 16000,
      channels: 1,
      raw: true,
      audio: {            // ← обязательно для raw PCM
        source: "microphone"
      },
      vad_events: true,
      interim_results: false,
      punctuate: true,
    });

    live.on("open", () => {
      console.log("Deepgram session opened.");
      dgReady = true;
    });

    live.on("close", () => {
      console.log("Deepgram closed");
      dgReady = false;
    });

    live.on("error", (err) => {
      console.error("Deepgram ERROR:", err);
      dgReady = false;
    });

    live.on("transcript", async (data) => {
      const t = data?.channel?.alternatives?.[0]?.transcript?.trim();
      if (!t) return;

      console.log("STT:", t);

      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: t }],
        temperature: 0.2,
        max_tokens: 200,
      });

      const answer = resp.choices?.[0]?.message?.content?.trim() || "";

      ws.send(JSON.stringify({
        type: "llm_response",
        transcript: t,
        response: answer,
      }));

      console.log("LLM:", answer);
    });

  } catch (e) {
    console.error("ERROR creating session:", e);
  }

  ws.on("message", (buffer) => {
    if (!dgReady) {
      console.log("PCM received but Deepgram not ready yet. Dropped.");
      return;
    }

    if (!Buffer.isBuffer(buffer)) return;

    try {
      live.send(buffer);
    } catch (e) {
      console.error("SEND error:", e);
    }
  });

  ws.on("close", () => {
    if (live) {
      try { live.finish(); } catch {}
    }
    console.log("Client disconnected");
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Listening on port", PORT));