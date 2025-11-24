// ===============================================
// Deepgram V2 RAW PCM Stream Server (stable)
// Unity -> PCM16 -> Deepgram -> GPT -> Unity
// ===============================================

const http = require("http");
const WebSocket = require("ws");
const OpenAI = require("openai");
const crypto = require("crypto");

// Deepgram endpoint (V2, stable, supports raw PCM)
const DG_URL = "wss://api.deepgram.com/v1/listen";

// ---------------------------------------
// HTTP server
// ---------------------------------------
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Deepgram V2 RAW server OK");
});

// ---------------------------------------
// WebSocket server for Unity
// ---------------------------------------
const wss = new WebSocket.Server({
  server,
  path: "/ws",
  maxPayload: 1024 * 1024,
  perMessageDeflate: false,
});

console.log("WebSocket ready.");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------------------------------------
// When Unity connects
// ---------------------------------------
wss.on("connection", (ws) => {
  console.log("Unity connected");

  // prevent Render timeout
  const pingInterval = setInterval(() => {
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {}
  }, 8000);

  // ---------------------------------------
  // Connect to Deepgram V2 raw WebSocket
  // ---------------------------------------
  const dgWs = new WebSocket(
    DG_URL +
      "?encoding=linear16&sample_rate=16000&channels=1&model=nova-2",
    {
      headers: {
        Authorization: "Token " + process.env.DEEPGRAM_API_KEY,
      },
    }
  );

  let dgReady = false;

  dgWs.on("open", () => {
    dgReady = true;
    console.log("Deepgram V2 connected.");
  });

  dgWs.on("error", (err) => {
    console.error("Deepgram ERROR:", err);
  });

  dgWs.on("close", () => {
    dgReady = false;
    console.log("Deepgram V2 closed");
  });

  // ---------------------------------------
  // Deepgram → Transcript → GPT → Unity
  // ---------------------------------------
  dgWs.on("message", async (msg) => {
    let data;

    try {
      data = JSON.parse(msg);
    } catch {
      return;
    }

    const transcript =
      data?.channel?.alternatives?.[0]?.transcript?.trim() || "";

    if (!transcript || transcript.length < 2) return;

    console.log("STT:", transcript);

    // GPT
    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: transcript }],
        max_tokens: 200,
        temperature: 0.2,
      });

      const answer = resp.choices?.[0]?.message?.content?.trim();
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

  // ---------------------------------------
  // Unity → PCM → Deepgram RAW stream
  // ---------------------------------------
  ws.on("message", (buffer) => {
    if (!Buffer.isBuffer(buffer)) return;

    console.log("PCM bytes:", buffer.length);

    if (!dgReady) {
      console.log("Deepgram not ready yet — skip chunk");
      return;
    }

    dgWs.send(buffer);
  });

  ws.on("close", () => {
    console.log("Unity disconnected");
    clearInterval(pingInterval);

    try {
      dgWs.close();
    } catch {}
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () =>
  console.log("Listening on port", PORT)
);