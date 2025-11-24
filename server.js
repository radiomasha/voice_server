const http = require("http");
const WebSocket = require("ws");
const { createClient } = require("@deepgram/sdk");
const OpenAI = require("openai");

const dg = createClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// HTTP stub
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Deepgram server OK");
});

// WebSocket server
const wss = new WebSocket.Server({ server, path: "/ws" });
console.log("WebSocket ready.");

wss.on("connection", async (ws) => {
  console.log("Client connected");

  // Deepgram live session
  const live = await dg.listen.live({
    model: "nova-2",
    language: "en",
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
    vad_events: true,
    punctuate: true,
    interim_results: false
  });

  live.on("open", () => console.log("Deepgram session opened"));
  live.on("error", (err) => console.error("Deepgram error:", err));

  // Deepgram transcript event
  live.on("transcript", async (data) => {
    const transcript =
      data?.channel?.alternatives?.[0]?.transcript?.trim() || "";

    if (!transcript || transcript.length < 2) return;

    console.log("STT:", transcript);

    try {
      const result = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: transcript }],
        max_tokens: 150,
        temperature: 0.2
      });

      const reply = result.choices?.[0]?.message?.content?.trim() || "";
      console.log("LLM:", reply);

      ws.send(
        JSON.stringify({
          type: "llm_response",
          transcript,
          response: reply
        })
      );

    } catch (err) {
      console.error("OpenAI error:", err);
    }
  });

  // Receive PCM audio from Unity
  ws.on("message", (msg) => {
    let obj;
    try {
      obj = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (obj.type !== "audio_chunk") return;

    const pcm = Buffer.from(obj.audio, "base64");
    live.send(pcm);
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    try {
      live.finish(); // правильное завершение deepgram stream
    } catch {}
  });
});

// start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Listening on port", PORT));