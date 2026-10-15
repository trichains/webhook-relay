// Mock alert receiver for CI: records every POST, lists them on GET /alerts.
import http from "node:http";

const alerts = [];

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.method === "POST") {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          body = { raw };
        }
        const entry = { at: new Date().toISOString(), path: req.url, contentType: req.headers["content-type"], body };
        alerts.push(entry);
        console.log(JSON.stringify(entry));
        res.writeHead(204).end();
      } else if (req.url === "/alerts") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(alerts));
      } else {
        res.writeHead(404).end();
      }
    });
  })
  .listen(9000, "0.0.0.0", () => console.log("alert-sink listening on :9000"));
