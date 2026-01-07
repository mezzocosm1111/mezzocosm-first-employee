
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

// --- Configuration ---
const PORT = process.env.PORT || 10000;
const GROK_API_KEY = process.env.GROK_API_KEY;
const VOICE = process.env.VOICE || "Ara";

// Knowledge Base
let systemInstructions = `You are Mezzo, a helpful AI assistant. 
CORE IDENTITY:
- Name: Mezzo
- Website: mezzocosm.com (SPELL THIS CORRECTLY: M-E-Z-Z-O-C-O-S-M)
- Philosophy: "Technology at the service of humans."
- IMPORTANT: The website is NOT "mezzohabitats". It is MEZZOCOSM.COM.

RULES:
- You are concise, warm, and professional.
- NEVER invent websites or phone numbers. Use ONLY what is in your Knowledge Base.
- If you don't know, refer to mezzocosm.com.
- HANGUP PROTOCOL: If you need to end the call (after saying goodbye), you MUST say "[HANGUP]" at the end of your sentence. This triggers the system to disconnect.`;
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

    grokWs.on("open", () => {
        console.log("Connected to Grok Realtime API 🚀");

        // 1. Configure Session (Native xAI Style)
        // Based on docs: Uses 'audio' nested object for codec config.
        const sessionConfig = {
            type: "session.update",
            session: {
                modalities: ["text", "audio"],
                voice: VOICE,
                instructions: systemInstructions,
                // New Config Structure from XAI Docs
                // Trying 'audio/pcmu' (u-law) at 8000Hz
                audio: {
                    input: {
                        format: { type: "audio/pcmu", rate: 8000 }
                    },
                    output: {
                        format: { type: "audio/pcmu", rate: 8000 }
                    }
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
                instructions: "Say exactly: 'Hi We're Mezzo. We build human scale habitats... can I ask what you're calling about today?'"
            }
        };
        setTimeout(() => grokWs.send(JSON.stringify(greeting)), 500);
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
            if (msg.type === "response.audio.transcript.done") {
                const transcript = msg.transcript || "";
                if (transcript.includes("[HANGUP]")) {
                    console.log("Hangup Trigger Detected from AI.");
                    hangupTriggered = true;
                }
            }

            // Execute Hangup after response is done
            if (msg.type === "response.done" && hangupTriggered) {
                console.log("Response Done. Executing Hangup.");
                // Give a small buffer for the audio to play out on the phone
                setTimeout(() => {
                    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
                }, 2000);
            }

            else if (msg.type === "error") {
                console.error("Grok Error:", JSON.stringify(msg, null, 2));
            }
        } catch (e) { console.error("Grok Message Error:", e); }
    });

    grokWs.on("error", (e) => console.error("Grok WebSocket Error:", e));
    grokWs.on("close", (code, reason) => {
        console.log(`Grok Connection Closed: ${code} ${reason}`);
        twilioWs.close();
    });

    twilioWs.on("close", () => grokWs.close());
    twilioWs.on("error", (e) => console.error("Twilio WebSocket Error:", e));
});

server.listen(PORT, () => console.log(`Mezzo (Grok Native) running on port ${PORT}`));
