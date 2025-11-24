// ======================================
// Deepgram v3 Streaming Server (working)
// For Unity PCM48 → PCM16 downsampled
// ======================================

const http = require("http");
const WebSocket = require("ws");
const { createClient } = require("@deepgram/sdk");
const OpenAI = require("openai");

// INIT APIS
const dg = createClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// HTTP stub
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Deepgram server OK");
});

// WS server
const wss = new WebSocket.Server({ server, path: "/ws" });
console.log("WebSocket ready.");

wss.on("connection", async (ws) => {
  console.log("Client connected");

  // CREATE Deepgram LIVE session
  const live = await dg.listen.live({
    model: "nova-2",
    language: "en",
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
    vad_events: true,
    punctuate: true,
    interim_results: false,
  });

  // Debug
  live.on("open", () => console.log("Deepgram session opened."));
  live.on("error", (err) => console.error("DG ERROR:", err));

  // TRANSCRIPT EVENT
  live.on("transcript", async (data) => {
    const transcript = data?.channel?.alternatives?.[0]?.transcript?.trim();

    if (!transcript || transcript.length < 2) return;

    console.log("STT:", transcript);

    // CALL GPT
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

  // RECEIVE AUDIO FROM UNITY
  ws.on("message", (msg) => {
    let obj;
    try {
      obj = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (obj.type === "audio_chunk") {
      const pcm = Buffer.from(obj.audio, "base64");
      live.send(pcm); // send raw 16k PCM to Deepgram
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    try {
      live.finish();
    } catch {}
  });
});

// start
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Listening on", PORT));