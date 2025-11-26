// ============================================================
// OpenAI Realtime Proxy — Fly.io → Unity → OpenAI → Unity
// Clean version: only final text forwarded to Unity.
// ============================================================
const http = require("http");
const WebSocket = require("ws");

const REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

// ------------------------------------------------------------
// HTTP SERVER (Fly.io Health Check)
// ------------------------------------------------------------
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OpenAI Realtime server OK\n");
});

// ------------------------------------------------------------
// WS SERVER FOR UNITY
// ------------------------------------------------------------
const wss = new WebSocket.Server({
  server,
  path: "/ws",
  maxPayload: 2 * 1024 * 1024,
  perMessageDeflate: false,
});

console.log("[SERVER] WS ready.");

// ============================================================
// MAIN HANDLER — UNITY CONNECTION
// ============================================================
wss.on("connection", (ws) => {
  console.log("[UNITY] connected");

  // Connect to OpenAI Realtime
  const rt = new WebSocket(REALTIME_URL, {
    headers: {
      Authorization: "Bearer " + process.env.OPENAI_API_KEY,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  let openaiReady = false;

  // ----------------------------
  // OPENAI CONNECTED
  // ----------------------------
  rt.on("open", () => {
    openaiReady = true;
    console.log("[OpenAI] Realtime connected");

    // Realtime session settings
    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions:
          "You are an empathetic, friendly VR ambassador. Speak naturally and concisely.",
        modalities: ["text"],
        input_audio_format: "pcm16",
        output_audio_format: "pcm16" // required by API but we ignore audio
      },
    };

    rt.send(JSON.stringify(sessionUpdate));
  });

  // ----------------------------
  // OPENAI CLOSED
  // ----------------------------
  rt.on("close", () => {
    openaiReady = false;
    console.log("[OpenAI] Realtime closed");
  });

  rt.on("error", (err) => {
    console.error("[OpenAI ERROR]", err);
  });

  // ============================================================
  // OPENAI → UNITY
  // Only final text is forwarded to avoid broken words.
  // ============================================================
  rt.on("message", (raw) => {
    const text = raw.toString();
    console.log("[OPENAI RAW]", text);

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // ignore non-json
    }

    // Ignore partial streaming
    if (parsed.type === "response.text.delta") return;

    // Forward ONLY final text
    if (parsed.type === "response.text.done") {
      const final = parsed.text || "";
      console.log("[OPENAI FINAL TEXT]", final);

      ws.send(
        JSON.stringify({
          type: "llm_response",
          response: final,
        })
      );
    }
  });

  // ============================================================
  // UNITY → OPENAI (Audio + Commit)
  // ============================================================
  ws.on("message", (buffer) => {
    let msg;
    try {
      msg = JSON.parse(buffer.toString("utf8"));
    } catch {
      console.error("[SERVER] Bad JSON from Unity");
      return;
    }

    if (!openaiReady) {
      console.log("[SERVER] OpenAI not ready — skipping");
      return;
    }

    // Audio chunk
    if (
      (msg.type === "input_audio_buffer.append" || msg.type === "pcm16") &&
      msg.audio
    ) {
      rt.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.audio,
        })
      );
    }

    // Commit (end of user speech)
    if (msg.type === "commit" || msg.type === "input_audio_buffer.commit") {
      console.log("[SERVER] Commit received → creating response.");
      rt.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      rt.send(JSON.stringify({ type: "response.create" }));
    }
  });

  ws.on("close", () => {
    console.log("[UNITY] disconnected");
    try {
      rt.close();
    } catch {}
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("[SERVER] Listening on", PORT);
});