import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { OpenAI } from "openai";
import dotenv from "dotenv";

dotenv.config();

// --- Configuration ---
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-4o-realtime-preview";
const VOICE = process.env.VOICE || "alloy";

if (!OPENAI_API_KEY) {
    console.error("CRITICAL: Missing OPENAI_API_KEY.");
    process.exit(1);
}

// --- Server Setup ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio" });

app.get("/", (req, res) => res.send("Mezzo Debug Server Active"));
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
    console.log("Debug Call Connected");

    const openaiWs = new WebSocket(
        `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
        { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
    );

    let streamSid = null;

    openaiWs.on("open", () => {
        console.log("Connected to OpenAI Realtime (Debug Mode)");

        // 1. Configure Session - MINIMAL
        const sessionConfig = {
            type: "session.update",
            session: {
                modalities: ["text", "audio"],
                voice: VOICE,
                instructions: "You are a helpful assistant. Keep answers short.",
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw",
                turn_detection: { type: "server_vad" }
            }
        };
        console.log("Sending Config:", JSON.stringify(sessionConfig));
        openaiWs.send(JSON.stringify(sessionConfig));

        // 2. Say Hello
        const greeting = {
            type: "response.create",
            response: {
                modalities: ["text", "audio"],
                instructions: "Say 'Hello, debugging mode is active.'",
            }
        };
        openaiWs.send(JSON.stringify(greeting));
    });

    // Handle Messages
    twilioWs.on("message", (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.event === "start") {
                streamSid = data.start.streamSid;
                console.log("Stream Started:", streamSid);
            } else if (data.event === "media" && openaiWs.readyState === WebSocket.OPEN) {
                openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data.media.payload }));
            } else if (data.event === "stop") {
                console.log("Stream Stopped");
                openaiWs.close();
            }
        } catch (e) { console.error(e); }
    });

    openaiWs.on("message", (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === "response.audio.delta" && msg.delta) {
                // Audio flowing!
                if (twilioWs.readyState === WebSocket.OPEN) {
                    twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.delta } }));
                }
            } else {
                console.log("OpenAI Event:", JSON.stringify(msg, null, 2));
            }
        } catch (e) { console.error(e); }
    });

    twilioWs.on("close", () => openaiWs.close());
    openaiWs.on("close", () => twilioWs.close());
});

server.listen(PORT, () => console.log(`Debug Server running on ${PORT}`));
