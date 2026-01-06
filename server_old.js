import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const VERSION = "mezzo-voice-bridge-v8-groundtruth-timeout";

const app = express();
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-realtime";
const VOICE = process.env.VOICE || "marin";

// Hard cap to prevent overnight calls.
// You can override in Render as MAX_CALL_SECONDS (optional).
const MAX_CALL_SECONDS = Number(process.env.MAX_CALL_SECONDS || 120);
const MAX_CALL_MS = Math.max(15, MAX_CALL_SECONDS) * 1000;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

app.get("/", (req, res) => {
  res.status(200).send(`OK - mezzocosm voice bridge running (${VERSION})`);
});

/**
 * Twilio Voice webhook -> TwiML that starts streaming audio to /twilio
 * IMPORTANT: No <Say>. The AI speaks first.
 */
app.post("/twilio-voice/inbound", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
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

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio" });

wss.on("connection", (twilioWs) => {
  console.log(`[${VERSION}] Twilio media websocket connected`);

  // One OpenAI WS per call => no cross-call memory by design.
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
  let introSent = false;
  let shuttingDown = false;

  // --- Brand intro (verbatim)
  const INTRO_SCRIPT =
    "Hi — we’re MEZZO, a small and dynamic design-build studio. " +
    "If you’d like immediate attention on your project, the fastest way to get started is to text us at this same number. " +
    "Our text-based assistant will help you right away, and one of us on the MEZZO team will reach out as soon as possible. " +
    "You can also find more information at mezzocosm.com — spelled M E Z Z O C O S M dot com. " +
    "Have a wonderful day.";

  // --- If caller speaks: controlled receptionist response (no budget/scope/timeline)
  const DEFER_SCRIPT =
    "We’re MEZZO. I’m the receptionist, so I can’t discuss budget, pricing, timelines, or project specifics on this call. " +
    "A MEZZO team member will call you back and take it from there. " +
    "For immediate attention, please text us at this same number.";

  // --- Hard timeout closing line (then hang up)
  const TIMEOUT_SCRIPT =
    "We’re MEZZO. I’m going to end this call now to keep the line available. " +
    "For immediate attention, please text us at this same number, and a MEZZO team member will follow up. " +
    "You can also find more information at mezzocosm.com — spelled M E Z Z O C O S M dot com. " +
    "Have a wonderful day.";

  // --- Ground truth facts (must override hallucinations)
  const GROUND_TRUTH =
    "GROUND TRUTH (must never contradict): " +
    "MEZZO / MEZZOCOSM is based in New York City. " +
    "Founder: Gabriel Brandt. " +
    "We do NOT operate primarily in Los Angeles and are not LA-based. " +
    "There is no founder named Aimee Lagos.";

  // --- What we do (only if asked)
  const SERVICES_FACTS =
    "If (and only if) the caller asks what we do: " +
    "We specialize in small habitats for B2B customers, ADUs, platforms built with ground-screw foundations, and saunas. " +
    "Keep it brief and then redirect to texting this number or mezzocosm.com for details.";

  // --- Behavioral rules
  const SYSTEM_RULES =
    "You are the MEZZO receptionist and part of the MEZZO team. " +
    "Use 'we' for company statements. Use 'I' only for your receptionist role/limits. " +
    "Never say 'they' or 'them' when referring to MEZZO/MEZZOCOSM. " +
    "Never paraphrase or reflect the caller (no 'I hear...', 'you said...', 'it sounds like...'). " +
    "Never discuss pricing, budgets, estimates, timelines, scope, or availability. " +
    "If asked about those, respond with the exact DEFER_SCRIPT provided to you. " +
    "Any question not about MEZZO or what we do must be politely declined and reframed to texting this number or the website; if needed, say a team member will follow up. " +
    "If asked about company story, meaning of the word, founder background, location, or anything deeper: defer to mezzocosm.com. " +
    "Treat every call as new; do not reference previous calls. " +
    GROUND_TRUTH +
    " " +
    SERVICES_FACTS;

  function safeCloseTwilio() {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      twilioWs.close();
    } catch {}
  }

  function safeCloseOpenAI() {
    try {
      openaiWs.close();
    } catch {}
  }

  function sendToOpenAI(obj) {
    try {
      openaiWs.send(JSON.stringify(obj));
    } catch {}
  }

  // Force verbatim output (prevents “they” drift and improvisation)
  function speakExact(text) {
    sendToOpenAI({
      type: "response.create",
      response: {
        voice: VOICE,
        instructions:
          "Say exactly the following text, word-for-word. " +
          "Do not add, remove, paraphrase, or change pronouns. " +
          "Never say 'they' or 'them'. " +
          "Text:\n" +
          text,
      },
    });
  }

  // Hard time limit: play closing, then end the call by closing the stream
  const callTimer = setTimeout(() => {
    // If OpenAI is up, speak the timeout line then hang up shortly after.
    try {
      speakExact(TIMEOUT_SCRIPT);
    } catch {}

    // Give it a moment to start speaking, then close stream.
    setTimeout(() => {
      safeCloseTwilio();
      safeCloseOpenAI();
    }, 2500);
  }, MAX_CALL_MS);

  openaiWs.on("open", () => {
    console.log(`[${VERSION}] OpenAI realtime websocket connected`);

    // Minimal schema (avoid unsupported fields)
    sendToOpenAI({
      type: "session.update",
      session: {
        voice: VOICE,
        instructions: SYSTEM_RULES,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: {
          type: "server_vad",
          threshold: 0.6,
          prefix_padding_ms: 200,
          silence_duration_ms: 450,
        },
      },
    });

    // Force intro immediately on every call
    introSent = true;
    speakExact(INTRO_SCRIPT);
  });

  openaiWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === "error") {
      console.log(`[${VERSION}] OpenAI error:`, msg);
      return;
    }

    if (msg.type === "response.audio.delta" && msg.delta && streamSid) {
      try {
        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: msg.delta },
          })
        );
      } catch {}
      return;
    }

    // Caller spoke -> do NOT free-form answer.
    // Always defer script (verbatim).
    if (msg.type === "input_audio_buffer.committed") {
      if (!introSent) {
        introSent = true;
        speakExact(INTRO_SCRIPT);
        return;
      }
      speakExact(DEFER_SCRIPT);
      return;
    }
  });

  twilioWs.on("message", (message) => {
    let evt;
    try {
      evt = JSON.parse(message.toString());
    } catch {
      return;
    }

    if (evt.event === "start") {
      streamSid = evt.start?.streamSid || null;
      console.log(`[${VERSION}] Twilio start streamSid: ${streamSid}`);
      return;
    }

    if (evt.event === "media") {
      sendToOpenAI({
        type: "input_audio_buffer.append",
        audio: evt.media.payload,
      });
      return;
    }

    if (evt.event === "stop") {
      console.log(`[${VERSION}] Twilio stop`);
      safeCloseOpenAI();
      return;
    }
  });

  function cleanup() {
    try {
      clearTimeout(callTimer);
    } catch {}
  }

  twilioWs.on("close", () => {
    console.log(`[${VERSION}] Twilio websocket closed`);
    cleanup();
    safeCloseOpenAI();
  });

  twilioWs.on("error", (err) => {
    console.log(`[${VERSION}] Twilio websocket error:`, err);
    cleanup();
    safeCloseOpenAI();
  });

  openaiWs.on("close", () => {
    console.log(`[${VERSION}] OpenAI websocket closed`);
    cleanup();
    safeCloseTwilio();
  });

  openaiWs.on("error", (err) => {
    console.log(`[${VERSION}] OpenAI websocket error:`, err);
    cleanup();
    safeCloseTwilio();
  });
});

server.listen(PORT, () => {
  console.log(`[${VERSION}] Server running on port ${PORT} (MAX_CALL_SECONDS=${MAX_CALL_SECONDS})`);
});
