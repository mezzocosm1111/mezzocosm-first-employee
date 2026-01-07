import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { OpenAI } from "openai";
import dotenv from "dotenv";

dotenv.config();

// --- Configuration & Constants ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths to Knowledge Base (Relative to this file in src/)
const ROOT_DIR = path.join(__dirname, "..");
const README_PATH = path.join(ROOT_DIR, "README.md");
const KB_PATH = path.join(ROOT_DIR, "sops", "knowledge_base.md");

const VERSION = "mezzo-brain-v2-unified";
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-4o-realtime-preview"; // Updated to stable alias
const CHAT_MODEL = process.env.CHAT_MODEL || "gpt-4o";
const VOICE = process.env.VOICE || "alloy"; // Switched to 'alloy' for reliability

if (!OPENAI_API_KEY) {
    console.error("CRITICAL: Missing OPENAI_API_KEY.");
    process.exit(1);
}

// --- Dynamic Content Loading ---
function loadSystemPrompt() {
    try {
        const readme = fs.readFileSync(README_PATH, "utf8");
        const kb = fs.readFileSync(KB_PATH, "utf8");
        return `${readme}\n\n# KNOWLEDGE BASE\n${kb}\n\n# CURRENT CONTEXT\nYou are the active Mezzo receptionist. Access the knowledge base above to answer questions.`;
    } catch (err) {
        console.error("Error loading system prompt files:", err);
        return "Error: System prompt could not be loaded. Please contact admin.";
    }
}

// Initialize Clients
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- HTTP Endpoints (Text) ---

app.get("/", (req, res) => {
    res.status(200).send(`OK - ${VERSION} active`);
});

app.get("/health", (req, res) => {
    res.status(200).json({
        status: "ok",
        service: VERSION,
        uptime: process.uptime()
    });
});

/**
 * Chat Endpoint (for n8n / SMS)
 * Usage: POST /chat { "message": "User text here" }
 */
app.post("/chat", async (req, res) => {
    const userMessage = req.body.message || req.body.body || ""; // Flexible input

    if (!userMessage) {
        return res.status(400).json({ error: "No message provided" });
    }

    try {
        const systemPrompt = loadSystemPrompt();

        const completion = await openai.chat.completions.create({
            model: CHAT_MODEL,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage }
            ],
            temperature: 0.2, // Deterministic
        });

        const reply = completion.choices[0].message.content;
        res.json({ reply });

    } catch (error) {
        console.error("Chat Error:", error);
        res.status(500).json({ error: "Internal processing error" });
    }
});

// --- Voice Logic (WebSocket) ---

/**
 * Twilio Voice Webhook
 * Returns TwiML to start the Media Stream
 */
app.post("/twilio-voice/inbound", (req, res) => {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    // If running locally with ngrok, host is the ngrok URL.
    // If on Render, it's the onrender.com URL.
    const streamUrl = `wss://${host}/twilio`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="source" value="twilio"/>
    </Stream>
  </Connect>
</Response>`;

    res.set("Content-Type", "text/xml");
    res.status(200).send(twiml);
});

// Create Server
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio" });

wss.on("connection", (twilioWs) => {
    console.log(`[${VERSION}] Call connected`);

    // Start with a clean, voice-specific persona.
    // NOTE: We do NOT use the README here because it contains "System Manifest" instructions
    // meant for the coding agent (e.g. "You are an operations manager"), which confuses the Voice Bot.
    const kbContent = fs.readFileSync(KB_PATH, "utf8");
    const systemInstructions =
        "# ROLE\n" +
        "You are Mezzo, a helpful, warm, and professional receptionist for a design-build studio.\n" +
        "Your goal is to answer questions using the Knowledge Base and qualify leads.\n\n" +
        "# KNOWLEDGE BASE\n" +
        kbContent + "\n\n" +
        "# VOICE SPECIFIC RULES\n" +
        "You are on the phone. " +
        "Keep responses extremely brief (1-2 sentences). " +
        "Speak clearly and professionally. " +
        "Use 'g711_ulaw' audio format.";

    // Connect to OpenAI Realtime API
    const openaiWs = new WebSocket(
        `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
        {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1",
            },
        }
    );

    let streamSid = null;

    openaiWs.on("open", () => {
        console.log("Connected to OpenAI Realtime");

        // Configure Session
        const sessionConfig = {
            type: "session.update",
            session: {
                modalities: ["text", "audio"],
                voice: VOICE,
                instructions: systemInstructions,
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw",
                turn_detection: {
                    type: "server_vad",
                    threshold: 0.6,
                    prefix_padding_ms: 200,
                    silence_duration_ms: 500,
                },
            },
        };

        console.log("Sending Session Config:", JSON.stringify(sessionConfig));
        openaiWs.send(JSON.stringify(sessionConfig));

        // Trigger the initial greeting from the AI
        const initialGreeting = {
            type: "response.create",
            response: {
                modalities: ["text", "audio"],
                instructions: "Say exactly: 'Hi this is Mezzo, a design/build studio specialized in small habitats. Are you calling about an ADU or something else?'",
            },
        };
        openaiWs.send(JSON.stringify(initialGreeting));
    });

    // Twilio -> OpenAI
    twilioWs.on("message", (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.event) {
                case "start":
                    streamSid = data.start.streamSid;
                    console.log(`Twilio Stream Started: ${streamSid}`);
                    break;
                case "media":
                    if (openaiWs.readyState === WebSocket.OPEN) {
                        const audioAppend = {
                            type: "input_audio_buffer.append",
                            audio: data.media.payload,
                        };
                        openaiWs.send(JSON.stringify(audioAppend));
                    }
                    break;
                case "stop":
                    console.log("Twilio Stream Stopped");
                    openaiWs.close();
                    break;
            }
        } catch (e) {
            console.error("Twilio message error:", e);
        }
    });

    // --- Timeout & Silence Logic ---
    const MAX_DURATION = 300000; // 5 minutes
    const SILENCE_WARNING_MS = 15000; // 15s to ask "Are you there?"
    const SILENCE_HANGUP_MS = 30000; // 30s total silence to hangup

    let silenceTimer = null;

    const clearSilenceTimer = () => {
        if (silenceTimer) clearTimeout(silenceTimer);
    };

    const startSilenceTimer = () => {
        clearSilenceTimer();
        silenceTimer = setTimeout(() => {
            console.log("Silence warning triggered");
            const warning = {
                type: "response.create",
                response: {
                    modalities: ["text", "audio"],
                    instructions: "Ask gently: 'Are you still there?'",
                },
            };
            if (openaiWs.readyState === WebSocket.OPEN) openaiWs.send(JSON.stringify(warning));

            // Set final Hangup timer (remaining 15s)
            silenceTimer = setTimeout(() => {
                console.log("Silence hangup triggered");
                if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
            }, SILENCE_HANGUP_MS - SILENCE_WARNING_MS);

        }, SILENCE_WARNING_MS);
    };

    // Global Call Limit
    setTimeout(() => {
        console.log("Max duration reached");
        if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    }, MAX_DURATION);


    // OpenAI -> Twilio
    openaiWs.on("message", (data) => {
        try {
            const msg = JSON.parse(data);

            if (msg.type === "response.audio.delta" && msg.delta) {
                // Audio flowing = Interaction active
                clearSilenceTimer();

                // Log that we are receiving audio (limiting spam to 1 in 10 or just ensuring it flows)
                console.log("Audio delta received: " + msg.delta.length + " bytes");

                if (twilioWs.readyState === WebSocket.OPEN) {
                    const audioDelta = {
                        event: "media",
                        streamSid: streamSid,
                        media: { payload: msg.delta },
                    };
                    twilioWs.send(JSON.stringify(audioDelta));
                }
            } else {
                if (msg.type === "error") {
                    console.error("OpenAI Error:", JSON.stringify(msg, null, 2));
                } else if (msg.type === "response.created") {
                    console.log("OpenAI Response Created");
                } else if (msg.type === "session.updated") {
                    console.log("OpenAI Session Updated");
                } else if (msg.type === "response.done") {
                    console.log("OpenAI Response Done - Waiting for user...");
                    startSilenceTimer();
                } else if (msg.type === "input_audio_buffer.speech_started") {
                    console.log("User Speech Started - Activity detected");
                    clearSilenceTimer();
                } else {
                    console.log("OpenAI Event:", msg.type);
                }
            }
        } catch (e) {
            console.error("OpenAI message error:", e);
        }
    });

    // Cleanup
    twilioWs.on("close", () => openaiWs.close());
    openaiWs.on("close", () => twilioWs.close());
});

// Start
server.listen(PORT, () => {
    console.log(`[${VERSION}] Server listening on port ${PORT}`);
});

process.on("SIGTERM", () => {
    console.log("SIGTERM received. Shutting down gracefully...");
    server.close(() => {
        console.log("HTTP server closed.");
        process.exit(0);
    });
});
