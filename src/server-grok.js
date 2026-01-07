import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fs from "fs";
import { ulawToPcm16, pcm16ToUlaw } from "./audio-utils.js";

dotenv.config();

// --- Configuration ---
const PORT = process.env.PORT || 10000;
const GROK_API_KEY = process.env.GROK_API_KEY;
// Start with NO model param to let it default, or try 'grok-beta' if this fails
// const REALTIME_MODEL = "grok-beta"; 
const VOICE = process.env.VOICE || "Ara"; // Updated to Ara as requested

// Knowledge Base
let systemInstructions = `You are Mezzo, a helpful AI assistant. You are concise, warm, and professional.`;
try {
    const kbPath = "./sops/knowledge_base.md";
    if (fs.existsSync(kbPath)) {
        const kbContent = fs.readFileSync(kbPath, "utf-8");
        systemInstructions += `\n\nGlobal Knowledge Base:\n${kbContent}`;
    }
} catch (e) {
    console.error("Warning: Could not load knowledge base.", e);
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
    console.log("New Call Connected (Grok Mode)");

    // Connect to xAI
    // Using wss://api.x.ai/v1/realtime as discovered
    // Not sending 'model' param initially to allow default.
    const grokUrl = "wss://api.x.ai/v1/realtime";
    console.log(`Connecting to Grok at ${grokUrl}`);

    const grokWs = new WebSocket(grokUrl, {
        headers: {
            Authorization: `Bearer ${GROK_API_KEY}`,
            "OpenAI-Beta": "realtime=v1" // Keep strictly for compatibility mode trigger if needed
        }
    });

    let streamSid = null;

    grokWs.on("open", () => {
        console.log("Connected to Grok Realtime API 🚀");

        // 1. Configure Session
        // Sending 'pcm16' because Grok likely doesn't support 'g711_ulaw' natively yet.
        const sessionConfig = {
            type: "session.update",
            session: {
                modalities: ["text", "audio"],
                voice: VOICE,
                instructions: systemInstructions,
                input_audio_format: "pcm16",
                output_audio_format: "pcm16",
                turn_detection: { type: "server_vad" }
            }
        };
        console.log("Sending Session Config (PCM16)...");
        grokWs.send(JSON.stringify(sessionConfig));

        // 2. Initial Trigger
        const greeting = {
            type: "response.create",
            response: {
                modalities: ["text", "audio"],
                instructions: "Greet the user warmly as Mezzo."
            }
        };
        // Small delay to ensure session is processed
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
                // Transcode Twilio (u-law) -> Grok (PCM16)
                const ulawBuffer = Buffer.from(data.media.payload, 'base64');
                const pcmBuffer = ulawToPcm16(ulawBuffer);

                const audioAppend = {
                    type: "input_audio_buffer.append",
                    audio: pcmBuffer.toString('base64')
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
                // Transcode Grok (PCM16) -> Twilio (u-law)
                const pcmBuffer = Buffer.from(msg.delta, 'base64');
                // Assuming Grok sends 24000Hz like Gemini/OpenAI standard, or 16000? 
                // Let's assume 24000 mostly, but we can verify.
                const ulawBuffer = pcm16ToUlaw(pcmBuffer, 24000);

                if (twilioWs.readyState === WebSocket.OPEN) {
                    twilioWs.send(JSON.stringify({
                        event: "media",
                        streamSid,
                        media: { payload: ulawBuffer.toString('base64') }
                    }));
                }
            } else if (msg.type === "error") {
                console.error("Grok Error:", JSON.stringify(msg, null, 2));
            } else {
                // Log other events sparingly
                // console.log("Grok Event:", msg.type);
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

server.listen(PORT, () => console.log(`Mezzo (Grok) running on port ${PORT}`));
