
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

// --- Configuration ---
const PORT = process.env.PORT || 10000;
const GROK_API_KEY = process.env.GROK_API_KEY;
const VOICE = process.env.VOICE || "Sal";

// Knowledge Base
// Knowledge Base
// Knowledge Base
let systemInstructions = `SYSTEM OVERRIDE:
You are Mezzo (AI). You are NOT human.
You must adhere STRICTLY to the attached FACT SHEET.
Any deviation (inventing names/numbers) is a CRITICAL ERROR.
If a fact is not in the sheet, say "I don't have that info."`;
try {
    const kbPath = "./sops/knowledge_base.md";
    if (fs.existsSync(kbPath)) {
        const kbContent = fs.readFileSync(kbPath, "utf-8");
        systemInstructions += "\n\n" + kbContent;
    }
} catch (error) {
    console.error("Error loading Knowledge Base:", error);
}

if (!GROK_API_KEY) {
    console.error("CRITICAL: Missing GROK_API_KEY.");
    process.exit(1);
}

// --- Server Setup ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio" });

app.get("/", (req, res) => res.send("Mezzo Grok Server Active"));
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Twilio Stream Webhook
app.post("/twilio-voice/inbound", (req, res) => {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const streamUrl = `wss://${host}/twilio`;
    res.set("Content-Type", "text/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`);
});

// WebSocket Handling
wss.on("connection", (twilioWs) => {
    console.log("New Call Connected (Grok Native Mode)");

    const grokUrl = "wss://api.x.ai/v1/realtime";
    console.log(`Connecting to Grok at ${grokUrl}`);

    const grokWs = new WebSocket(grokUrl, {
        headers: {
            Authorization: `Bearer ${GROK_API_KEY}`,
            "OpenAI-Beta": "realtime=v1"
        }
    });

    let streamSid = null;
    let hangupTriggered = false;

    grokWs.on("open", () => {
        console.log("Connected to Grok Realtime API 🚀");

        // Dynamic System Data
        const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
        const timeInstruction = `\nCURRENT TIME (EST): ${now}. You MUST use this time.`;
        const fullInstructions = systemInstructions + timeInstruction;

        // 1. Configure Session (Native xAI Style)
        const sessionConfig = {
            type: "session.update",
            session: {
                modalities: ["text", "audio"],
                voice: VOICE,
                instructions: fullInstructions,
                audio: {
                    input: { format: { type: "audio/pcmu", rate: 8000 } },
                    output: { format: { type: "audio/pcmu", rate: 8000 } }
                },
                turn_detection: { type: "server_vad" }
            }
        };
        console.log("Sending Session Config (Native u-law 8k)...");
        grokWs.send(JSON.stringify(sessionConfig));

        // 2. Initial Trigger
        const greeting = {
            type: "response.create",
            response: {
                modalities: ["text", "audio"],
                instructions: "Identity Check: You are MEZZO. (Short for MEZZOCOSM). Say exactly: 'Hi We're Mezzo. We build human scale habitats... can I ask what you're calling about today?'"
            }
        };
        setTimeout(() => grokWs.send(JSON.stringify(greeting)), 500);

        // Heartbeat (Keep-Alive)
        const outputHeartbeat = setInterval(() => {
            if (grokWs.readyState === WebSocket.OPEN) {
                grokWs.ping();
            }
        }, 30000);

        grokWs.on("close", () => clearInterval(outputHeartbeat));
    });

    // Handle Twilio Messages
    twilioWs.on("message", (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.event === "start") {
                streamSid = data.start.streamSid;
                console.log("Twilio Stream Started:", streamSid);
            } else if (data.event === "media" && grokWs.readyState === WebSocket.OPEN) {
                // PASSTHROUGH (Native)
                const audioAppend = {
                    type: "input_audio_buffer.append",
                    audio: data.media.payload
                };
                grokWs.send(JSON.stringify(audioAppend));
            } else if (data.event === "stop") {
                console.log("Twilio Stream Stopped");
                grokWs.close();
            }
        } catch (e) { console.error("Twilio Error:", e); }
    });

    // Handle Grok Messages
    grokWs.on("message", (data) => {
        try {
            const msg = JSON.parse(data);

            if (msg.type === "response.audio.delta" && msg.delta) {
                // PASSTHROUGH (Native)
                if (twilioWs.readyState === WebSocket.OPEN) {
                    twilioWs.send(JSON.stringify({
                        event: "media",
                        streamSid,
                        media: { payload: msg.delta }
                    }));
                }
            }

            // Detect Transcript for Hangup Trigger
            if (msg.type === "response.audio_transcript.done") {
                const transcript = msg.transcript || "";
                console.log("AI Transcript:", transcript); // DEBUG LOG

                // ROBUST REGEX MATCH
                if (/\[?hang\s*up\]?/i.test(transcript)) {
                    console.log("Hangup Trigger Detected via Regex:", transcript);
                    if (!hangupTriggered) {
                        hangupTriggered = true;
                        console.log("Initiating Hangup Sequence (2s delay)...");
                        setTimeout(() => {
                            if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
                        }, 2000);
                    }
                }
            }

            // Log Error
            else if (msg.type === "error") {
                console.error("Grok Error:", JSON.stringify(msg, null, 2));
            }
        } catch (e) { console.error("Grok Message Error:", e); }
    });

    grokWs.on("error", (e) => console.error("Grok WebSocket Error:", e));
    grokWs.on("close", (code, reason) => {
        console.log(`Grok Connection Closed: ${code} ${reason}`);
        if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    });

    twilioWs.on("close", () => {
        if (grokWs.readyState === WebSocket.OPEN) grokWs.close();
    });
    twilioWs.on("error", (e) => console.error("Twilio WebSocket Error:", e));
});

// process-level error handling
process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception:", err);
    // Keep running if possible, or exit gracefully
});
process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Graceful Shutdown
process.on("SIGTERM", () => {
    console.log("Received SIGTERM. Shutting down gracefully...");
    server.close(() => {
        console.log("Server closed.");
        process.exit(0);
    });
});

server.keepAliveTimeout = 120 * 1000;
server.headersTimeout = 120 * 1000;

server.listen(PORT, () => console.log(`Mezzo (Grok Native) running on port ${PORT}`));
