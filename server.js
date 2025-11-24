// =============================================
// Deepgram Streaming STT Server (SDK v3.x)
// For Unity PCM 16k, VR assistant
// =============================================

const http = require("http");
const WebSocket = require("ws");
const { Deepgram } = require("@deepgram/sdk");
const OpenAI = require("openai");

// Init API clients
const deepgram = new Deepgram({ apiKey: process.env.DEEPGRAM_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Simple HTTP endpoint
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Deepgram VR server OK");
});

// WebSocket server
const wss = new WebSocket.Server({ server, path: "/ws" });
console.log("WebSocket server ready.");

wss.on("connection", async (ws) => {
  console.log("Client connected");

  // Create Deepgram streaming connection
  const dg = deepgram.listenLive({
    model: "nova-2",
    language: "en",             // English only
    smart_format: true,
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
    vad_events: true,           // silence detection
    interim_results: false
  });

  // DG connected
  dg.on("open", () => console.log("Deepgram stream opened"));

  // DG transcript event
  dg.on("transcript", async (data) => {
    try {
      const transcript = data?.channel?.alternatives?.[0]?.transcript?.trim();

      if (!transcript || transcript.length < 2) return; // ignore noise

      console.log("STT:", transcript);

      // ---- Call GPT ----
      const llm = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: transcript }],
        max_tokens: 200,
        temperature: 0.4
      });

      const reply = llm.choices[0].message.content.trim();
      console.log("LLM:", reply);

      // ---- Send to Unity ----
      ws.send(JSON.stringify({
        type: "llm_response",
        transcript,
        response: reply
      }));

    } catch (err) {
      console.error("LLM error:", err);
    }
  });

  // Receive PCM chunks from Unity
  ws.on("message", (msg) => {
    let obj;
    try {
      obj = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (obj.type !== "audio_chunk") return;

    const pcm16 = Buffer.from(obj.audio, "base64");

    // Send directly to Deepgram
    dg.send(pcm16);
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    dg.close();
  });
});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Listening on", PORT));