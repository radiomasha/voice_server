// ==========================================================
// Deepgram V2 — RAW PCM 16kHz Server
// Unity → PCM → Deepgram → GPT → Unity
// ==========================================================

const http = require("http");
const WebSocket = require("ws");
const OpenAI = require("openai");

// Deepgram V2 RAW endpoint
const DG_URL =
  "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&model=nova-2";

// -----------------------------------------------------------
// HTTP server (Render will open the port automatically)
// -----------------------------------------------------------
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Deepgram V2 RAW server OK");
});

// -----------------------------------------------------------
// WS server (Unity connects here)
// -----------------------------------------------------------
const wss = new WebSocket.Server({
  server,
  path: "/ws",
  maxPayload: 2 * 1024 * 1024,
  perMessageDeflate: false,
});

console.log("WebSocket ready.");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -----------------------------------------------------------
// UNITY CONNECTS
// -----------------------------------------------------------
wss.on("connection", async (ws) => {
  console.log("Unity connected");

  // keep-alive (Render kills idle WS after ~55s)
  const pingInterval = setInterval(() => {
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch (_) {}
  }, 8000);

  // ---------------------------------------------------------
  // CONNECT TO DEEPGRAM RAW PCM SOCKET (V2)
  // ---------------------------------------------------------
  const dgWs = new WebSocket(DG_URL, {
    headers: {
      Authorization: "Token " + process.env.DEEPGRAM_API_KEY,
    },
  });

  let dgReady = false;

  dgWs.on("open", () => {
    dgReady = true;
    console.log("Deepgram V2 connected.");
  });

  dgWs.on("close", () => {
    dgReady = false;
    console.log("Deepgram V2 closed");
  });

  dgWs.on("error", (err) => {
    console.error("Deepgram ERROR:", err);
  });

  // ---------------------------------------------------------
  // DEEPGRAM → STT → GPT → UNITY
  // ---------------------------------------------------------
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

    // ask GPT
    let answer = "";
    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: transcript }],
        max_tokens: 150,
      });

      answer = resp.choices?.[0]?.message?.content?.trim() || "";
      console.log("LLM:", answer);
    } catch (err) {
      console.error("GPT error:", err);
    }

    // send answer to Unity
    try {
      ws.send(
        JSON.stringify({
          type: "llm_response",
          transcript,
          response: answer,
        })
      );
    } catch {}
  });

  // ---------------------------------------------------------
  // UNITY → PCM → DEEPGRAM
  // ---------------------------------------------------------
  ws.on("message", (buffer) => {
    if (!Buffer.isBuffer(buffer)) return;

    console.log("PCM bytes:", buffer.length);

    if (!dgReady) {
      console.log("Deepgram not ready — skip");
      return;
    }

    try {
      dgWs.send(buffer);
    } catch (err) {
      console.error("Deepgram send error:", err);
    }
  });

  // ---------------------------------------------------------
  // CLEANUP
  // ---------------------------------------------------------
  ws.on("close", () => {
    console.log("Unity disconnected");
    clearInterval(pingInterval);

    try {
      dgWs.close();
    } catch {}
  });
});

// -----------------------------------------------------------
// START SERVER
// -----------------------------------------------------------
const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
  console.log("Listening on port", PORT);
});