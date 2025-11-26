// ============================================================================
// OpenAI Realtime Proxy — WORKING VERSION with emotional instructions
// Fly.io → Unity (JSON PCM) → OpenAI → Unity → ElevenLabs
// ============================================================================

const http = require("http");
const WebSocket = require("ws");

const REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

// ---------------------------------------------------------------------------
// HTTP health check
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OpenAI Realtime server OK\n");
});

// ---------------------------------------------------------------------------
// WebSocket server for Unity
// ---------------------------------------------------------------------------
const wss = new WebSocket.Server({
  server,
  path: "/ws",
  maxPayload: 2 * 1024 * 1024,
  perMessageDeflate: false,
});

console.log("[SERVER] WS ready.");


// ============================================================================
// FINAL TEXT SENDER WITH DEDUPLICATION
// ============================================================================
function makeFinalSender(ws) {
  let lastId = null;

  return (responseId, text) => {
    if (!text) return;
    if (responseId && responseId === lastId) return;
    if (responseId) lastId = responseId;

    console.log("[OPENAI FINAL TEXT]", text);

    ws.send(
      JSON.stringify({
        type: "llm_response",
        response: text,
      })
    );
  };
}


// ============================================================================
// UNITY CONNECTION
// ============================================================================
wss.on("connection", (ws) => {
  console.log("[UNITY] connected");

  // --- Connect to OpenAI Realtime
  const rt = new WebSocket(REALTIME_URL, {
    headers: {
      Authorization: "Bearer " + process.env.OPENAI_API_KEY,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  let openaiReady = false;
  let assistantSpeaking = false;

  const sendFinalText = makeFinalSender(ws);


  // ==========================================================================
  // OPENAI CONNECTED → SETUP SESSION WITH NEW EMOTIONAL PROMPT
  // ==========================================================================
  rt.on("open", () => {
    openaiReady = true;
    console.log("[OpenAI] Realtime connected");

    const session = {
      type: "session.update",
      session: {
        instructions: `
You are a warm, emotionally intelligent English-speaking conversational partner.
Your rules:
Speak naturally and concisely. Use short sentences (6–14 words).
Listen carefully to user tone. If user sounds irritated, tired, angry or upset:
   - stay calm
   - be supportive but not apologetic
   - avoid rambling and long explanations
   - keep answers short and direct
If user sounds happy or relaxed — mirror the energy lightly.
Never repeat yourself. Never use generic greetings. No “Hello”, “Hi”, or long intros.
Ask simple, natural follow-up questions, only one at a time.
If user begins speaking, stop your response immediately.
        `,
        modalities: ["audio", "text"],
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: {
          model: "gpt-4o-mini-transcribe",
        },
      },
    };

    rt.send(JSON.stringify(session));
  });


  rt.on("close", () => {
    openaiReady = false;
    console.log("[OpenAI] Realtime closed");
  });

  rt.on("error", (err) => {
    console.error("[OpenAI ERROR]", err);
  });


  // ==========================================================================
  // SOFT INTERRUPTION
  // ==========================================================================
  function interruptAssistant() {
    if (!openaiReady || !assistantSpeaking) return;

    console.log("[INTERRUPT] Cancel assistant response");

    assistantSpeaking = false;
    rt.send(JSON.stringify({ type: "response.cancel" }));
  }


  // ==========================================================================
  // OPENAI → UNITY
  // ==========================================================================
  rt.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Track assistant audio status
    if (msg.type === "response.audio.delta") {
      assistantSpeaking = true;
      return;
    }

    if (msg.type === "response.audio.done") {
      assistantSpeaking = false;
      return;
    }

    // Full transcript event
    if (msg.type === "response.audio_transcript.done") {
      const text = msg.transcript || "";
      const id = msg.response_id || null;
      sendFinalText(id, text);
      return;
    }

    // response.done
    if (msg.type === "response.done") {
      const response = msg.response || {};
      const id = response.id || null;

      let final = "";

      const firstOutput = Array.isArray(response.output)
        ? response.output[0]
        : null;

      const firstContent =
        firstOutput &&
        Array.isArray(firstOutput.content)
          ? firstOutput.content[0]
          : null;

      if (firstContent) {
        final = firstContent.transcript || firstContent.text || "";
      }

      if (final) sendFinalText(id, final);

      assistantSpeaking = false;
      return;
    }

    // fallback
    if (msg.type === "response.text.done") {
      const text = msg.text || "";
      const id = msg.response_id || null;
      sendFinalText(id, text);
    }
  });


  // ==========================================================================
  // UNITY → OPENAI
  // ==========================================================================
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      console.error("[SERVER] Bad JSON from Unity");
      return;
    }

    if (!openaiReady) return;

    // Audio chunk (from Unity WebSocketClient)
    if ((msg.type === "pcm16" || msg.type === "input_audio_buffer.append") && msg.audio) {
      interruptAssistant();

      rt.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.audio,
        })
      );

      return;
    }

    // Commit
    if (msg.type === "commit") {
      console.log("[SERVER] Commit → creating response");

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


// ---------------------------------------------------------------------------
// START SERVER
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("[SERVER] Listening on", PORT);
});