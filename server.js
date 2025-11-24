// ======================================
// Deepgram v3 Streaming Server (with RAW logs)
// ======================================

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

const wss = new WebSocket.Server({ server, path: "/ws" });
console.log("WebSocket ready.");

wss.on("connection", async (ws) => {
  console.log("Client connected");

  // HEARTBEAT (Render fix)
  const pingInterval = setInterval(() => {
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {}
  }, 8000);

  // Deepgram live session
  const live = await dg.listen.live({
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


  // ======================================================
  // RECEIVE RAW WS MESSAGE (NO PARSE)
  // ======================================================
  ws.on("message", (msg) => {
    console.log("\n==== RAW MESSAGE RECEIVED ====");
    console.log("Type:", typeof msg);
    console.log("Length:", msg.length);

    let text = msg.toString();
    console.log("First 200 chars:", text.slice(0, 200));

    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      console.log("JSON PARSE FAILED:", e.message);
      return;
    }

    if (obj.type !== "audio_chunk") return;

    const pcm = Buffer.from(obj.audio, "base64");
    console.log("PCM decoded bytes:", pcm.length);

    live.send(pcm);
  });


  // TRANSCRIPT EVENT
  live.on("transcript", async (data) => {
    const transcript = data?.channel?.alternatives?.[0]?.transcript?.trim();

    if (!transcript || transcript.length < 2) return;

    console.log("STT:", transcript);

    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: transcript }],
        max_tokens: 150,
        temperature: 0.2,
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
      console.error("GPT error:", err);
    }
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    try { live.finish(); } catch {}
    console.log("Client disconnected");
  });
});

// START
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Listening on", PORT));