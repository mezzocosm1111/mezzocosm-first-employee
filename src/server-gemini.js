/**
 * Mezzo Brain (Gemini Edition)
 * Replaces OpenAI Realtime with Google Multimodal Live API.
 */
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { ulawToPcm16, pcm16ToUlaw } from "./audio-utils.js";

dotenv.config();

// --- Config ---
const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Force a valid Gemini voice. Render might still have VOICE=alloy set.
let inputVoice = process.env.VOICE || "Puck";
const validVoices = ["Puck", "Charon", "Kore", "Fenrir", "Aoede"];
if (!validVoices.includes(inputVoice)) {
    console.log(`[Mezzo] Warning: '${inputVoice}' is not a valid Gemini voice. Defaulting to 'Puck'.`);
    inputVoice = "Puck";
}
const VOICE_NAME = inputVoice;
const MODEL_NAME = "models/gemini-2.0-flash-exp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KB_PATH = path.join(__dirname, "..", "sops", "knowledge_base.md");

if (!GEMINI_API_KEY) {
    console.error("CRITICAL: Missing GEMINI_API_KEY");
    process.exit(1);
}

// --- App Setup ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio" });

// Health Check
app.get("/", (req, res) => res.send("Mezzo (Gemini) Active"));
app.get("/health", (req, res) => res.json({ status: "ok", service: "mezzo-gemini" }));

// Twilio Webhook
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

// --- WebSocket Logic ---
wss.on("connection", (twilioWs) => {
    console.log("[Mezzo] Call Connected");
    let streamSid = null;
    let geminiWs = null;

    try {
        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
        geminiWs = new WebSocket(url);
    } catch (err) {
        console.error("Gemini Connection Error:", err);
        return;
    }

    geminiWs.on("error", (err) => {
        console.error("Gemini WebSocket Error:", err);
    });

    geminiWs.on("close", (code, reason) => {
        console.log(`[Mezzo] Gemini Disconnected: ${code} - ${reason}`);
        if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    });

    geminiWs.on("open", () => {
        console.log("[Mezzo] Connected to Gemini");

        // 1. Send Setup Message
        let kbContent = "Mezzo Knowledge Base:\n";
        try {
            kbContent += fs.readFileSync(KB_PATH, "utf8");
        } catch (e) { console.error("KB Load Error", e); }

        const systemInstruction =
            "You are Mezzo, a helpful, warm, and professional receptionist for a design-build studio.\n" +
            "Your goal is to answer questions using the Knowledge Base and qualify leads.\n" +
            "Keep responses brief (1-2 sentences). Speak clearly. Do not use markdown formatting in speech.\n\n" +
            kbContent;

        const setupMsg = {
            setup: {
                model: MODEL_NAME,
                generation_config: {
                    response_modalities: ["AUDIO"],
                    speech_config: {
                        voice_config: { prebuilt_voice_config: { voice_name: VOICE_NAME } }
                    }
                },
                system_instruction: {
                    parts: [{ text: systemInstruction }]
                }
            }
        };

        console.log("Sending Setup:", JSON.stringify(setupMsg).substring(0, 200) + "..."); // Log brief
        geminiWs.send(JSON.stringify(setupMsg));

        // 2. Send Initial Greeting (Delayed to ensure Setup is processed)
        setTimeout(() => {
            const greetingMsg = {
                client_content: {
                    turns: [{
                        role: "user",
                        parts: [{ text: "Introduce yourself please." }]
                    }],
                    turn_complete: true
                }
            };
            console.log("Sending Greeting Trigger");
            if (geminiWs.readyState === WebSocket.OPEN) {
                geminiWs.send(JSON.stringify(greetingMsg));
            }
        }, 500);
    });

    geminiWs.on("message", (data) => {
        try {
            const msg = JSON.parse(data.toString());

            if (msg.serverContent && msg.serverContent.modelTurn) {
                const parts = msg.serverContent.modelTurn.parts;
                for (const part of parts) {
                    if (part.inlineData && part.inlineData.mimeType.startsWith("audio/pcm")) {
                        // Received PCM Audio
                        const pcmBase64 = part.inlineData.data;
                        const pcmBuffer = Buffer.from(pcmBase64, "base64");

                        // Convert PCM -> u-law
                        // Gemini sends 24kHz usually. We assume 24kHz -> 8kHz.
                        const ulawBuffer = pcm16ToUlaw(pcmBuffer, 24000);

                        if (twilioWs.readyState === WebSocket.OPEN) {
                            const payload = ulawBuffer.toString("base64");
                            twilioWs.send(JSON.stringify({
                                event: "media",
                                streamSid: streamSid,
                                media: { payload: payload }
                            }));
                        }
                    }
                }
            } else if (msg.serverContent && msg.serverContent.turnComplete) {
                // Turn done
                // console.log("Gemini Turn Complete");
            }
        } catch (e) {
            console.error("Gemini Message Error:", e);
        }
    });

    // Twilio -> Gemini
    twilioWs.on("message", (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.event === "start") {
                streamSid = data.start.streamSid;
                console.log("Stream Started:", streamSid);
            } else if (data.event === "media") {
                if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
                    // 1. Decode u-law -> PCM16
                    const ulawBuffer = Buffer.from(data.media.payload, "base64");
                    const pcmBuffer = ulawToPcm16(ulawBuffer);

                    // 2. Send to Gemini
                    const inputMsg = {
                        realtime_input: {
                            media_chunks: [{
                                mime_type: "audio/pcm",
                                data: pcmBuffer.toString("base64")
                            }]
                        }
                    };
                    geminiWs.send(JSON.stringify(inputMsg));
                }
            } else if (data.event === "stop") {
                console.log("Stream Stopped");
                if (geminiWs) geminiWs.close();
            }
        } catch (e) { console.error(e); }
    });

    twilioWs.on("close", () => {
        if (geminiWs) geminiWs.close();
    });
});

server.listen(PORT, () => {
    console.log(`[Mezzo-Gemini] Server running on port ${PORT}`);
});
