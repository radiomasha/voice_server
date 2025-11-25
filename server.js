// ============================================================
// OpenAI Realtime Proxy for Unity (PCM16 → Realtime → GPT → Unity)
// Fly.io-ready Node WebSocket server
// ============================================================

const http = require("http");
const WebSocket = require("ws");
const OpenAI = require("openai");

// Realtime endpoint (WebSocket upgrade)
const REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

// ------------------------------------------------------------
// HTTP server for Fly.io
// ------------------------------------------------------------
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("OpenAI Realtime server OK");
});

// ------------------------------------------------------------
// WebSocket server for Unity
// ------------------------------------------------------------
const wss = new WebSocket.Server({
  server,
  path: "/ws",
  maxPayload: 2 * 1024 * 1024,
  perMessageDeflate: false,
});

console.log("[SERVER] WebSocket ready.");

// ------------------------------------------------------------
// UNITY → (our server) → OPENAI REALTIME
// ------------------------------------------------------------
wss.on("connection", async (ws) => {
  console.log("[UNITY] Connected");

  // Keep-alive
  const pingInterval = setInterval(() => {
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {}
  }, 8000);

  // --------------------------------------------------------
  // CONNECT TO OPENAI REALTIME
  // --------------------------------------------------------
  const rt = new WebSocket(REALTIME_URL, {
    headers: {
      Authorization: "Bearer " + process.env.OPENAI_API_KEY,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  let openaiReady = false;

  rt.on("open", () => {
    console.log("[OpenAI] Realtime connected.");
    openaiReady = true;

    // Send initial session config
    rt.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions:
            "You are an empathetic, friendly VR ambassador. Speak naturally. Respond concisely. Remember context within this session.",
          modalities: ["text", "audio"], // we accept audio input
          input_audio_format: "pcm16",
          input_audio_sample_rate: 16000,
          output_audio_format: "none", // we use ElevenLabs for TTS
          turn_detection: { type: "none" }, // unity handles VAD
        },
      })
    );
  });

  rt.on("close", () => {
    openaiReady = false;
    console.log("[OpenAI] Realtime closed");
  });

  rt.on("error", (err) => {
    console.error("[OpenAI ERROR]", err);
  });

  // --------------------------------------------------------
  // OPENAI REALTIME → UNITY (transcript + final response)
  // --------------------------------------------------------
  rt.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    // 1) Partial transcript
    if (data.type === "response.output_text.delta") {
      ws.send(
        JSON.stringify({
          type: "partial",
          text: data.delta,
        })
      );
    }

    // 2) Final model response (text)
    if (data.type === "response.completed") {
      const txt =
        data?.response?.output_text || data?.response?.output_message;

      let final = "";

      if (Array.isArray(txt)) {
        for (const t of txt) final += t;
      }

      ws.send(
        JSON.stringify({
          type: "llm_response",
          response: final.trim(),
        })
      );

      console.log("[LLM]", final);
    }
  });

  // --------------------------------------------------------
  // UNITY → PCM16 → OPENAI REALTIME
  // --------------------------------------------------------
  ws.on("message", (buffer) => {
    if (!Buffer.isBuffer(buffer)) return;

    if (!openaiReady) {
      console.log("[OpenAI] Not ready — skip audio");
      return;
    }

    // Send PCM16 bytes → Realtime
    rt.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: buffer.toString("base64"),
      })
    );
  });

  // --------------------------------------------------------
  // CLEANUP
  // --------------------------------------------------------
  ws.on("close", () => {
    console.log("[UNITY] Disconnected");
    clearInterval(pingInterval);
    try {
      rt.close();
    } catch {}
  });
});

// ------------------------------------------------------------
// START HTTP SERVER ON FLY.IO
// ------------------------------------------------------------
const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
  console.log("[SERVER] Listening on port", PORT);
});