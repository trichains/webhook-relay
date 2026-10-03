import { ImageResponse } from "next/og";

export const alt = "Webhook Relay: verify, deduplicate, retry and replay webhooks";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  const steps = ["verify", "dedupe", "store", "deliver", "retry", "replay"];
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          background: "#0b0c0e",
          color: "#e7e8eb",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ fontSize: 28, color: "#9ba1ab" }}>trichains/webhook-relay</div>
        <div style={{ fontSize: 88, fontWeight: 700, marginTop: 16, letterSpacing: -2 }}>Webhook Relay</div>
        <div style={{ fontSize: 34, color: "#9ba1ab", marginTop: 20, maxWidth: 900 }}>
          A webhook gateway for payment and sales platforms.
        </div>
        <div style={{ display: "flex", marginTop: 56, gap: 16 }}>
          {steps.map((step, i) => (
            <div
              key={step}
              style={{
                display: "flex",
                padding: "10px 22px",
                borderRadius: 10,
                border: `2px solid ${i === steps.length - 1 ? "#f2884b" : "#343944"}`,
                color: i === steps.length - 1 ? "#f2884b" : "#e7e8eb",
                fontSize: 28,
              }}
            >
              {step}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
