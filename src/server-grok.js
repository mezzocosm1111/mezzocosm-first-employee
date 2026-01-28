
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fs from "fs";
import Twilio from "twilio";

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
If a fact is not in the sheet, say "I don't have that info."
IMPORTANT: You make decisions. You are the gatekeeper.
TERMINATION PROTOCOL:
1. **Ambiguous Endings ("I'm done", "That's it")**:
   - Do NOT hang up immediately.
   - Ask: "Is there anything else, or would you like me to hang up?"
   - If they say "hang up" or "no nothing else" -> Say "Goodbye." + "[HANG UP]".
   - If they have more questions -> Continue.

2. **Explicit Endings**:
   - User says "Bye", "Wrong number", "Not interested" -> Say "Understood. Goodbye." + "[HANG UP]".

3. **Misalignment / Time Wasting**:
   - User asks for out-of-scope work (Commercial, Plumbing, etc) -> Disqualify politely -> Say "We can't help with that. [HANG UP]".

4. **HEARING CORRECTION (CRITICAL)**:
   - If you hear "Death": You likely misheard "Deck" or "Depth".
   - If you hear an alarming term but the tone is calm: ASK FOR CLARIFICATION.
   - Example: "Did you say you want to talk about a deck, or something else?"
   - Do NOT hang up on "Death" without clarifying first, as it is a common transcription error for "Deck".

Example:
User: "I think I'm done."
AI: "Okay. Would you like me to hang up?"
User: "Yes please."
AI: "Alright, take care. [HANG UP]"`;
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

// Twilio Client
const twilioClient = new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);


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
    let callSid = null;
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
                callSid = data.start.callSid;
                console.log(`Twilio Stream Started: ${streamSid} (Call: ${callSid})`);
            } else if (data.event === "media" && grokWs.readyState === WebSocket.OPEN) {
                // PASSTHROUGH (Native)
                resetSilenceTimer(); // User is speaking
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

            // Verify Input Transcription (What did the AI hear?)
            if (msg.type === "conversation.item.created" && msg.item && msg.item.role === "user") {
                const userText = JSON.stringify(msg.item.content);
                console.log("USER INPUT DETECTED (Item Created):", userText);
            }
            if (msg.type === "conversation.item.input_audio_transcription.completed") {
                const text = msg.transcript;
                console.log("USER TRANSCRIPT:", text);
                conversationHistory.push({ role: "User", content: text });
            }

            // Verify Model Output (Text parts vs Audio parts)
            if (msg.type === "response.content_part.done" && msg.part) {
                if (msg.part.type === "text") {
                    const text = msg.part.text;
                    console.log("AI TEXT PART:", text);
                    conversationHistory.push({ role: "AI", content: text });
                }
            }

            // Detect Transcript for Hangup Trigger
            if (msg.type === "response.audio_transcript.done") {
                const transcript = msg.transcript || "";
                console.log("AI Transcript:", transcript); // DEBUG LOG

                // ROBUST REGEX MATCH 
                // Fix: Removed loose "hang up" to prevent triggering on questions like "Would you like me to hang up?"
                // Now matching: [HANG UP] OR closing salutations.
                const hangupPatterns = /\[hang\s*up\]|goodbye|bye\b|have a (?:great|nice) day/i;
                if (hangupPatterns.test(transcript)) {
                    console.log("Hangup Trigger Detected via Regex:", transcript);
                    if (!hangupTriggered) {
                        hangupTriggered = true;

                        if (callSid) {
                            console.log(`Initiating API Hangup for Call ${callSid}...`);
                            twilioClient.calls(callSid)
                                .update({ status: 'completed' })
                                .then(call => console.log(`Call ${call.sid} terminated via API`))
                                .catch(err => console.error("Twilio API Hangup Error:", err));
                        } else {
                            console.error("No CallSid found! Falling back to stream close.");
                            setTimeout(() => {
                                if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
                            }, 1000);
                        }
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

    // Silence Detection (Two-Stage)
    const SILENCE_WARNING_MS = 15000; // 15 seconds to warn
    const SILENCE_HANGUP_MS = 30000;  // 30 seconds total to hangup
    let warningTimer = null;
    let hangupTimer = null;

    const resetSilenceTimer = () => {
        if (warningTimer) clearTimeout(warningTimer);
        if (hangupTimer) clearTimeout(hangupTimer);

        // Stage 1: Warning
        warningTimer = setTimeout(() => {
            console.log("Silence Warning: Prompting AI check-in.");
            const checkIn = {
                type: "response.create",
                response: {
                    modalities: ["text", "audio"],
                    instructions: "The user has been silent for a while. Ask gently: 'Are you still with me? If you need to go, just let me know.'"
                }
            };
            if (grokWs.readyState === WebSocket.OPEN) grokWs.send(JSON.stringify(checkIn));
        }, SILENCE_WARNING_MS);

        // Stage 2: Hard Hangup
        hangupTimer = setTimeout(() => {
            console.log("Silence Timeout: Hanging up due to inactivity.");
            if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
            if (grokWs.readyState === WebSocket.OPEN) grokWs.close();
            if (callSid) {
                twilioClient.calls(callSid).update({ status: 'completed' }).catch(console.error);
            }
        }, SILENCE_HANGUP_MS);
    };

    // State for Data Egress
    let conversationHistory = [];

    // Helper: Send to n8n
    const sendToN8N = async () => {
        const webhookUrl = process.env.N8N_WEBHOOK_URL;
        if (!webhookUrl) return console.log("Skipping n8n export: No N8N_WEBHOOK_URL set.");

        const payload = {
            source: "voice_agent",
            call_sid: callSid || "unknown",
            stream_sid: streamSid || "unknown",
            caller_number: "unknown", // Twilio doesn't pass caller ID in raw stream connect, would need initial HTTP context or params
            transcript_text: conversationHistory.map(item => `${item.role}: ${item.content}`).join("\n"),
            timestamp: new Date().toISOString()
        };

        console.log(`📤 Exporting Call Data to n8n (${payload.transcript_text.length} chars)...`);

        try {
            // We use dynamic import for node-fetch if needed, or built-in fetch in Node 18+
            const response = await fetch(webhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            console.log(`n8n Webhook Response: ${response.status} ${response.statusText}`);
        } catch (error) {
            console.error("❌ Failed to send data to n8n:", error);
        }
    };

    twilioWs.on("close", () => {
        if (warningTimer) clearTimeout(warningTimer);
        if (hangupTimer) clearTimeout(hangupTimer);
        if (grokWs.readyState === WebSocket.OPEN) grokWs.close();

        // Trigger Egress
        sendToN8N();
    });
    twilioWs.on("error", (e) => console.error("Twilio WebSocket Error:", e));

    // Reset silence timer on initial connection
    resetSilenceTimer();
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
