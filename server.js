const http = require("http");
const WebSocket = require("ws");

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("WS echo test OK");
});

const wss = new WebSocket.Server({
  server,
  path: "/ws",
  perMessageDeflate: false
});

console.log("WS test server ready.");

wss.on("connection", (ws) => {
  console.log("Unity connected");

  ws.on("message", (msg) => {
    console.log("Received:", msg.length, "bytes");
    ws.send("echo_ok");
  });

  ws.on("close", () => {
    console.log("Unity disconnected");
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Listening on port", PORT));